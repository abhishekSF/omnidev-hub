let ws = null;
let currentEngine = 'auto';
let pendingApprovalTaskId = null;
let pendingApprovalCommit = null;
let recognition = null;
let isRecording = false;

// Token management
function getAuthToken() {
  const urlParams = new URLSearchParams(window.location.search);
  let token = urlParams.get('token');
  if (token) {
    localStorage.setItem('omnidev_token', token);
    return token;
  }
  token = localStorage.getItem('omnidev_token');
  if (!token) {
    token = prompt('Enter your OmniDev Hub Auth Token (displayed in daemon terminal):');
    if (token) localStorage.setItem('omnidev_token', token.trim());
  }
  return token || '';
}

// Initialize WebSocket connection
function initWebSocket() {
  const token = getAuthToken();
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}?token=${encodeURIComponent(token)}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    log('Connected to OmniDev Fleet Host (Authenticated).');
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
    log(`Disconnected from host (code: ${event.code}). Reconnecting in 3s...`);
    document.getElementById('fleet-status-dot').className = 'w-2 h-2 rounded-full bg-red-500 inline-block';
    if (event.code === 4401) {
      localStorage.removeItem('omnidev_token');
      alert('Authentication failed: Invalid Token.');
    } else {
      setTimeout(initWebSocket, 3000);
    }
  };
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'FLEET_INIT':
      updateFleetTelemetry(msg.profile, msg.leases);
      updateRepositorySelect(msg.allowedRepositories);
      if (msg.pendingApprovals && msg.pendingApprovals.length > 0) {
        showApprovalModal(msg.pendingApprovals[0]);
      }
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
      log(`[ERROR] ${msg.error}`);
      break;
  }
}

function updateRepositorySelect(repos) {
  const select = document.getElementById('repo-select');
  if (!repos || repos.length === 0) {
    select.innerHTML = '<option value="">No repositories registered</option>';
    return;
  }
  select.innerHTML = repos.map(r => `<option value="${r}">${r}</option>`).join('');
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
  document.getElementById('terminal-stream').innerHTML = '';
}

function setEngine(engine) {
  currentEngine = engine;
  document.querySelectorAll('.engine-chip').forEach(chip => {
    chip.className = 'engine-chip py-2 px-3 rounded-xl border border-gray-800 bg-gray-900/60 text-gray-400 font-medium flex items-center justify-between';
    const span = chip.querySelectorAll('span')[1];
    if (span) span.remove();
  });

  const selected = document.getElementById(`chip-${engine}`);
  if (selected) {
    selected.className = 'engine-chip py-2 px-3 rounded-xl border border-blue-500 bg-blue-950/60 text-blue-300 font-medium flex items-center justify-between';
    const check = document.createElement('span');
    check.textContent = '✓';
    selected.appendChild(check);
  }
}

function submitPrompt() {
  const input = document.getElementById('prompt-input');
  const repoSelect = document.getElementById('repo-select');
  const prompt = input.value.trim();
  const repoPath = repoSelect.value;

  if (!prompt || !ws) return;
  if (!repoPath) {
    alert('Please select an approved repository from the dropdown.');
    return;
  }

  const taskId = `task_${Date.now()}`;
  log(`Dispatching prompt to [${currentEngine.toUpperCase()}] on repo [${repoPath}]: "${prompt}"`);

  const pipelineCard = document.getElementById('pipeline-card');
  pipelineCard.classList.remove('hidden');
  document.getElementById('active-task-id').textContent = taskId;
  document.getElementById('pipeline-stepper').innerHTML = `
    <div class="text-blue-400">⏳ 1. Initializing isolated worktree...</div>
  `;

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

  // Verification Evidence handling
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

// Voice Recognition via Web Speech API
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
    submitPrompt();
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

// Enter key to submit
document.getElementById('prompt-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    submitPrompt();
  }
});

// Start on load
window.addEventListener('load', initWebSocket);
