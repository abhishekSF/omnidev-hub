let ws = null;
let currentEngine = 'auto';
let pendingApprovalTaskId = null;
let pendingApprovalCommit = null;
let recognition = null;
let isRecording = false;
let reconnectTimer = null;

function stripTokenFromUrl() {
  const url = new URL(window.location.href);
  if (url.searchParams.has('token')) {
    url.searchParams.delete('token');
    const next = url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : '') + url.hash;
    history.replaceState({}, '', next);
    log('Query-string tokens are no longer accepted. Pair with the daemon code instead.');
  }
}

async function api(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(pathname, {
    credentials: 'same-origin',
    ...options,
    headers
  });
  return res;
}

function showPairing(message) {
  const overlay = document.getElementById('pairing-overlay');
  overlay.classList.remove('hidden');
  overlay.style.display = 'flex';
  const err = document.getElementById('pairing-error');
  if (message) {
    err.textContent = message;
    err.classList.remove('hidden');
  } else {
    err.classList.add('hidden');
  }
}

function hidePairing() {
  const overlay = document.getElementById('pairing-overlay');
  overlay.classList.add('hidden');
  overlay.style.display = 'none';
}

async function ensureSession() {
  const status = await api('/api/session');
  return status.ok;
}

async function pairWithSecret(secret) {
  const res = await api('/api/session', {
    method: 'POST',
    body: JSON.stringify({ pairingCode: secret })
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Pairing failed');
  }
}

function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    log('Connected to OmniDev Hub (session cookie).');
    document.getElementById('fleet-status-dot').className = 'w-2 h-2 rounded-full bg-emerald-500 inline-block animate-pulse';
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch (err) {
      console.error('Failed to parse WebSocket message:', err);
    }
  };

  ws.onclose = (event) => {
    log(`Disconnected from host (code: ${event.code}).`);
    document.getElementById('fleet-status-dot').className = 'w-2 h-2 rounded-full bg-red-500 inline-block';
    if (event.code === 4401 || event.code === 1008) {
      showPairing('Session expired. Enter a new pairing code.');
      return;
    }
    if (event.code === 1006 || event.code === 1002 || event.code === 1000) {
      // 401 on upgrade often surfaces as an abnormal close.
      ensureSession().then((ok) => {
        if (!ok) {
          showPairing('Pair this device to continue.');
          return;
        }
        reconnectTimer = setTimeout(initWebSocket, 3000);
      });
      return;
    }
    reconnectTimer = setTimeout(initWebSocket, 3000);
  };
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'FLEET_INIT':
      updateFleetTelemetry(msg.profile, msg.leases);
      updateRepositorySelect(msg.allowedRepositories);
      updateEngineAvailability(msg.availableEngines);
      if (msg.pendingApprovals && msg.pendingApprovals.length > 0) {
        showApprovalModal(msg.pendingApprovals[0]);
      }
      break;

    case 'REPOS_UPDATED':
      updateRepositorySelect(msg.allowedRepositories);
      break;

    case 'FLEET_UPDATE':
      updateFleetTelemetry(msg.profile, msg.leases);
      break;

    case 'LOG':
      log(msg.message);
      break;

    case 'ADAPTER_EVENT':
      handleAdapterEvent(msg.data);
      break;

    case 'STAGE':
      updatePipelineStage(msg.stage);
      break;

    case 'APPROVAL_REQUIRED':
      showApprovalModal(msg.data);
      break;

    case 'DONE':
      log(`Task ${msg.data.taskId} finished with status: ${msg.data.status}`);
      hideApprovalModal();
      break;

    case 'ERROR':
      log(`[ERROR] ${typeof msg.error === 'string' ? msg.error : (msg.error?.error || JSON.stringify(msg.error))}`);
      break;
  }
}

function updateRepositorySelect(repos) {
  const select = document.getElementById('repo-select');
  const previous = select.value;
  select.replaceChildren();
  if (!repos || repos.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No repositories registered';
    select.appendChild(opt);
    return;
  }
  for (const repo of repos) {
    const opt = document.createElement('option');
    opt.value = repo;
    opt.textContent = repo;
    select.appendChild(opt);
  }
  if (previous && repos.includes(previous)) {
    select.value = previous;
  }
}

function updateEngineAvailability(engines) {
  if (!engines) return;
  const available = new Set(engines.filter((e) => e.available).map((e) => e.id));
  for (const id of ['cursor', 'antigravity', 'opencode']) {
    const chip = document.getElementById(`chip-${id}`);
    if (!chip) continue;
    const found = available.has(id);
    chip.disabled = !found;
    chip.style.opacity = found ? '1' : '0.4';
    chip.title = found ? '' : 'CLI not found on this host';
  }
}

function updateFleetTelemetry(profile, leases) {
  if (!profile) return;
  document.getElementById('fleet-host-name').textContent = profile.hostname;
  document.getElementById('hw-tier').textContent = `${profile.computeTier} (${profile.arch})`;

  const batt = profile.powerState.batteryPercent !== null ? `${profile.powerState.batteryPercent}%` : 'AC Power';
  document.getElementById('fleet-battery-pill').textContent = `🔋 ${batt}`;

  const hasLease = leases && leases.length > 0;
  const leaseEl = document.getElementById('keepawake-status');
  if (hasLease) {
    leaseEl.textContent = `Awake (${leases.length} leases)`;
    leaseEl.className = 'text-emerald-400 font-medium ml-1';
  } else {
    leaseEl.textContent = 'Idle';
    leaseEl.className = 'text-gray-400 font-medium ml-1';
  }
}

function handleAdapterEvent(data) {
  if (data.ev?.type === 'stdout' || data.ev?.type === 'stderr') {
    log(`[${data.engine}] ${data.ev.data}`);
  } else if (data.ev?.type === 'step') {
    log(`[${data.engine} step] ${JSON.stringify(data.ev.data)}`);
  }
}

function log(text) {
  const container = document.getElementById('terminal-stream');
  const div = document.createElement('div');
  div.textContent = `> ${text}`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function clearLogs() {
  document.getElementById('terminal-stream').replaceChildren();
}

function setEngine(engine) {
  const chip = document.getElementById(`chip-${engine}`);
  if (chip && chip.disabled) return;
  currentEngine = engine;
  document.querySelectorAll('.engine-chip').forEach((el) => {
    el.className = 'engine-chip py-2 px-3 rounded-xl border border-gray-800 bg-gray-900/60 text-gray-400 font-medium flex items-center justify-between';
    const extra = el.querySelector('[data-check="1"]');
    if (extra) extra.remove();
  });

  const selected = document.getElementById(`chip-${engine}`);
  if (selected) {
    selected.className = 'engine-chip py-2 px-3 rounded-xl border border-blue-500 bg-blue-950/60 text-blue-300 font-medium flex items-center justify-between';
    const check = document.createElement('span');
    check.dataset.check = '1';
    check.textContent = '✓';
    selected.appendChild(check);
  }
}

function submitPrompt() {
  const input = document.getElementById('prompt-input');
  const repoSelect = document.getElementById('repo-select');
  const prompt = input.value.trim();
  const repoPath = repoSelect.value;

  if (!prompt || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (!repoPath) {
    alert('Register and select a repository first.');
    return;
  }

  const taskId = `task_${Date.now()}`;
  log(`Dispatching prompt to [${currentEngine.toUpperCase()}] on repo [${repoPath}]: "${prompt}"`);

  const pipelineCard = document.getElementById('pipeline-card');
  pipelineCard.classList.remove('hidden');
  document.getElementById('active-task-id').textContent = taskId;
  document.getElementById('pipeline-stepper').replaceChildren();
  const step = document.createElement('div');
  step.className = 'text-blue-400';
  step.textContent = '⏳ 1. Initializing isolated worktree...';
  document.getElementById('pipeline-stepper').appendChild(step);

  ws.send(JSON.stringify({
    type: 'DISPATCH_TASK',
    id: taskId,
    repoPath,
    prompt,
    engine: currentEngine
  }));

  input.value = '';
}

function updatePipelineStage(stage) {
  const stepper = document.getElementById('pipeline-stepper');
  const div = document.createElement('div');
  div.className = stage.status === 'COMPLETED' ? 'text-emerald-400' : (stage.status === 'RUNNING' ? 'text-amber-400 animate-pulse' : 'text-gray-400');
  div.textContent = `• [${stage.name}] ${stage.engine ? '(' + stage.engine + ')' : ''}: ${stage.status}`;
  stepper.appendChild(div);
}

let pendingIsUnverified = false;

function toggleApproveButton() {
  const btn = document.getElementById('approve-btn');
  if (!pendingIsUnverified) {
    btn.disabled = false;
    btn.className = 'py-2.5 rounded-xl bg-emerald-600 border border-emerald-500 text-white text-xs font-bold shadow-lg shadow-emerald-900/40 active:bg-emerald-500 cursor-pointer';
  } else {
    const ack = document.getElementById('unverified-ack')?.checked;
    btn.disabled = !ack;
    btn.className = ack
      ? 'py-2.5 rounded-xl bg-amber-600 border border-amber-500 text-white text-xs font-bold shadow-lg shadow-amber-900/40 active:bg-amber-500 cursor-pointer'
      : 'py-2.5 rounded-xl bg-gray-700 border border-gray-600 text-gray-400 text-xs font-bold cursor-not-allowed';
  }
}

function showApprovalModal(data) {
  pendingApprovalTaskId = data.taskId;
  pendingApprovalCommit = data.candidateCommit;
  const card = document.getElementById('approval-card');
  card.classList.remove('hidden');
  document.getElementById('approval-branch').textContent = `${data.branch} (${data.candidateCommit ? data.candidateCommit.slice(0, 7) : 'HEAD'})`;
  document.getElementById('approval-diff').textContent = data.diff;

  const v = data.verification;
  const vBanner = document.getElementById('verification-banner');
  const vBadge = document.getElementById('verification-badge');
  const vTime = document.getElementById('verification-time');
  const vMsg = document.getElementById('verification-message');
  const vLog = document.getElementById('verification-log-details');
  const vStdout = document.getElementById('verification-stdout');
  const unverifiedBox = document.getElementById('unverified-override-box');
  const unverifiedAck = document.getElementById('unverified-ack');

  if (unverifiedAck) unverifiedAck.checked = false;

  if (v && v.status === 'VERIFIED') {
    pendingIsUnverified = false;
    vBanner.className = 'p-2.5 rounded-xl text-xs space-y-1.5 border border-emerald-700/60 bg-emerald-950/20';
    vBadge.className = 'font-bold text-xs text-emerald-400';
    vBadge.textContent = `✅ VERIFIED: ${v.command}`;
    vTime.textContent = `${v.durationMs || 0}ms`;
    vMsg.textContent = v.message;
    unverifiedBox.classList.add('hidden');

    if (v.stdout && v.stdout.trim().length > 0) {
      vLog.classList.remove('hidden');
      vStdout.textContent = v.stdout;
    } else {
      vLog.classList.add('hidden');
    }
  } else {
    pendingIsUnverified = true;
    vBanner.className = 'p-2.5 rounded-xl text-xs space-y-1.5 border border-amber-700/60 bg-amber-950/20';
    vBadge.className = 'font-bold text-xs text-amber-400';
    vBadge.textContent = '⚠️ UNVERIFIED (No designated test script)';
    vTime.textContent = '';
    vMsg.textContent = v?.message || 'No tests were executed. Code verification was NOT performed.';
    vLog.classList.add('hidden');
    unverifiedBox.classList.remove('hidden');
  }

  toggleApproveButton();
  log(`Approval required for task: ${data.taskId} (Candidate Commit: ${data.candidateCommit}, Status: ${v?.status || 'UNVERIFIED'})`);
}

function hideApprovalModal() {
  document.getElementById('approval-card').classList.add('hidden');
  pendingApprovalTaskId = null;
  pendingApprovalCommit = null;
  pendingIsUnverified = false;
}

function approveCurrentTask() {
  if (!pendingApprovalTaskId || !pendingApprovalCommit || !ws) return;
  const allowUnverified = pendingIsUnverified && (document.getElementById('unverified-ack')?.checked || false);

  if (pendingIsUnverified && !allowUnverified) {
    alert('You must check the confirmation box before approving unverified code.');
    return;
  }

  ws.send(JSON.stringify({
    type: 'APPROVE_TASK',
    taskId: pendingApprovalTaskId,
    candidateCommit: pendingApprovalCommit,
    allowUnverified
  }));
  hideApprovalModal();
}

function rejectCurrentTask() {
  if (!pendingApprovalTaskId || !ws) return;
  ws.send(JSON.stringify({
    type: 'REJECT_TASK',
    taskId: pendingApprovalTaskId
  }));
  hideApprovalModal();
}

function toggleVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    alert('Web Speech API is not supported on this browser. Try Safari on iOS.');
    return;
  }

  if (isRecording) {
    recognition.stop();
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.interimResults = false;

  recognition.onstart = () => {
    isRecording = true;
    const btn = document.getElementById('voice-btn');
    btn.classList.add('orb-pulse', 'from-red-600', 'to-rose-500');
    document.getElementById('voice-label').textContent = 'Listening... (Speak now)';
  };

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    document.getElementById('prompt-input').value = transcript;
    log(`Voice input captured: "${transcript}"`);
  };

  recognition.onend = () => {
    isRecording = false;
    const btn = document.getElementById('voice-btn');
    btn.classList.remove('orb-pulse', 'from-red-600', 'to-rose-500');
    document.getElementById('voice-label').textContent = 'Tap to speak';
  };

  recognition.onerror = (event) => {
    console.error('Speech recognition error:', event.error);
    isRecording = false;
    document.getElementById('voice-label').textContent = 'Tap to speak';
  };

  recognition.start();
}

async function addRepository() {
  const input = document.getElementById('repo-add-input');
  const repoPath = input.value.trim();
  if (!repoPath) return;
  const res = await api('/api/repos', {
    method: 'POST',
    body: JSON.stringify({ path: repoPath })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(body.error || 'Failed to register repository');
    return;
  }
  updateRepositorySelect(body.repositories);
  input.value = '';
  log(`Registered repository ${repoPath}`);
}

document.getElementById('prompt-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    submitPrompt();
  }
});

document.getElementById('pairing-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const secret = document.getElementById('pairing-input').value.trim();
  if (!secret) return;
  try {
    await pairWithSecret(secret);
    hidePairing();
    initWebSocket();
  } catch (err) {
    showPairing(err.message);
  }
});

document.getElementById('repo-add-btn').addEventListener('click', () => {
  addRepository();
});

window.addEventListener('load', async () => {
  stripTokenFromUrl();
  const paired = await ensureSession();
  if (!paired) {
    showPairing();
    return;
  }
  initWebSocket();
});
