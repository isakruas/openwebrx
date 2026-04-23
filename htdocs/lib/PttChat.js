(function () {
  'use strict';

  var ROUND_ID = 1;
  var API_BASE = 'https://id.qsl.br';
  var PTT_WS_URL = 'wss://id.qsl.br/api/ptt-sfu/ws';
  var ICE_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  var SPEAKER_ID_KEY = 'oqso:ptt:speaker-id';

  var speakerId = '';
  var connected = false;
  var connecting = false;
  var connectEnabled = false;
  var pttHeld = false;
  var pttBusy = false;
  var autoReconnect = false;
  var reconnectAttempts = 0;

  var ionSignal = null;
  var ionClient = null;
  var ionLocalStream = null;
  var remoteAudios = new Map();
  var renewTimer = null;
  var reconnectTimer = null;

  function getSpeakerId() {
    try {
      var existing = localStorage.getItem(SPEAKER_ID_KEY);
      if (existing) return existing;
      var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(SPEAKER_ID_KEY, id);
      return id;
    } catch (e) {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Falha ao carregar ' + src)); };
      document.head.appendChild(s);
    });
  }

  function ensureSdk() {
    if (window.IonSDK && window.Signal) return Promise.resolve();
    return loadScript('https://unpkg.com/ion-sdk-js@1.5.5/dist/ion-sdk.min.js')
      .then(function () {
        return loadScript('https://unpkg.com/ion-sdk-js@1.5.5/dist/json-rpc.min.js');
      });
  }

  function apiCall(method, path, body) {
    return fetch(API_BASE + path, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
        if (!res.ok) {
          var msg = (data && data.detail && data.detail.message) ||
                    (data && data.detail) || (data && data.message) || res.statusText;
          var err = new Error(typeof msg === 'string' ? msg : 'Erro de API');
          err.payload = data;
          throw err;
        }
        return data;
      });
    });
  }

  function clearReconnectTimer() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function stopReconnect() {
    autoReconnect = false;
    reconnectAttempts = 0;
    clearReconnectTimer();
  }

  function scheduleReconnect() {
    if (!autoReconnect || connected || connecting || !connectEnabled) return;
    clearReconnectTimer();
    reconnectAttempts++;
    var wait = Math.min(10000, 1000 * Math.pow(2, Math.min(reconnectAttempts, 3)));
    reconnectTimer = setTimeout(function () { connectAudio(true); }, wait);
  }

  function cleanupRemoteAudios() {
    remoteAudios.forEach(function (audio) {
      try { audio.pause(); audio.srcObject = null; audio.remove(); } catch (e) {}
    });
    remoteAudios = new Map();
  }

  function disconnectAudio() {
    if (renewTimer) { clearInterval(renewTimer); renewTimer = null; }
    pttHeld = false;
    pttBusy = false;
    if (ionLocalStream) { try { ionLocalStream.mute('audio'); } catch (e) {} }
    if (ionSignal && typeof ionSignal.close === 'function') { try { ionSignal.close(); } catch (e) {} }
    ionSignal = null;
    ionClient = null;
    ionLocalStream = null;
    connected = false;
    connecting = false;
    cleanupRemoteAudios();
    updateUI();
  }

  function onSignalClosed() {
    if (!connected && !connecting) return;
    setError('Conexão de áudio interrompida.');
    disconnectAudio();
    scheduleReconnect();
    if (connectEnabled) updateConnectBtn();
  }

  function connectAudio(auto) {
    if (connecting || connected || !connectEnabled) return Promise.resolve();
    connecting = true;
    if (!auto) setError('');
    autoReconnect = true;
    updateUI();

    return ensureSdk().then(function () {
      ionSignal = new window.Signal.IonSFUJSONRPCSignal(PTT_WS_URL);
      ionClient = new window.IonSDK.Client(ionSignal, ICE_CONFIG);

      ionClient.ontrack = function (track, stream) {
        track.onunmute = function () {
          if (remoteAudios.has(stream.id)) return;
          var audio = document.createElement('audio');
          audio.autoplay = true;
          audio.srcObject = stream;
          audio.style.display = 'none';
          document.body.appendChild(audio);
          remoteAudios.set(stream.id, audio);
          stream.onremovetrack = function () {
            var el = remoteAudios.get(stream.id);
            if (el) { el.remove(); remoteAudios.delete(stream.id); }
          };
        };
      };

      var sid = 'round-' + ROUND_ID;
      var joined = new Promise(function (resolve, reject) {
        ionSignal.onopen = function () {
          ionClient.join(sid).then(resolve).catch(reject);
        };
      });
      ionSignal.onclose = onSignalClosed;
      ionSignal.onerror = onSignalClosed;

      return window.IonSDK.LocalStream.getUserMedia({ audio: true, video: false })
        .then(function (stream) {
          ionLocalStream = stream;
          ionLocalStream.mute('audio');
          return joined;
        })
        .then(function () {
          ionClient.publish(ionLocalStream);
          connected = true;
          reconnectAttempts = 0;
          setError('');
        });
    }).catch(function (err) {
      setError((err && err.message) || 'Falha ao iniciar áudio PTT.');
      disconnectAudio();
      scheduleReconnect();
    }).then(function () {
      connecting = false;
      updateUI();
    });
  }

  function startPtt() {
    if (!connected || pttHeld || pttBusy) return;
    pttBusy = true;
    setError('');

    apiCall('POST', '/api/public/rounds/' + ROUND_ID + '/ptt/acquire', {
      speaker_id: speakerId,
      speaker_label: 'Ouvinte',
    }).then(function () {
      if (ionLocalStream) ionLocalStream.unmute('audio');
      pttHeld = true;
      if (renewTimer) clearInterval(renewTimer);
      renewTimer = setInterval(function () {
        if (!pttHeld) return;
        apiCall('POST', '/api/public/rounds/' + ROUND_ID + '/ptt/renew', { speaker_id: speakerId })
          .catch(function () { stopPtt(true); });
      }, 3000);
    }).catch(function (err) {
      var detail = err && err.payload && err.payload.detail;
      if (detail && typeof detail === 'object') {
        var who = String(detail.speaker_label || '').trim();
        setError(who ? 'PTT em uso por ' + who + '.' : 'PTT em uso por outro ouvinte.');
      } else {
        setError((err && err.message) || 'Falha ao solicitar PTT.');
      }
    }).then(function () {
      pttBusy = false;
      updateUI();
    });
  }

  function stopPtt(force) {
    if (renewTimer) { clearInterval(renewTimer); renewTimer = null; }
    pttHeld = false;
    try { if (ionLocalStream) ionLocalStream.mute('audio'); } catch (e) {}
    updateUI();
    if (!force) {
      apiCall('POST', '/api/public/rounds/' + ROUND_ID + '/ptt/release', { speaker_id: speakerId })
        .catch(function () {});
    }
  }

  function el(id) { return document.getElementById(id); }

  function setError(msg) {
    var e = el('owrx-ptt-error');
    if (!e) return;
    e.textContent = msg;
    e.style.display = msg ? '' : 'none';
  }

  function updateConnectBtn() {
    var btn = el('owrx-ptt-connect-btn');
    if (!btn) return;
    if (connectEnabled) {
      btn.textContent = connected ? '● Áudio Ativo' : connecting ? 'Conectando...' : '◌ Ativando...';
      btn.classList.add('active');
    } else {
      btn.textContent = 'Ativar Áudio';
      btn.classList.remove('active');
    }
  }

  function updateUI() {
    updateConnectBtn();
    var pttBtn = el('owrx-ptt-btn');
    if (pttBtn) {
      pttBtn.disabled = !(connected && !pttBusy);
      pttBtn.classList.toggle('pressed', pttHeld);
    }
    var status = el('owrx-ptt-status');
    if (status) {
      if (!connectEnabled) status.textContent = 'Desconectado';
      else if (connecting) status.textContent = 'Conectando áudio...';
      else if (connected && pttHeld) status.textContent = 'Transmitindo...';
      else if (connected) status.textContent = 'Pressione e segure para falar';
      else status.textContent = 'Aguardando reconexão...';
    }
  }

  window.owrxPttToggle = function () {
    var panel = el('owrx-ptt-panel');
    if (!panel) return;
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
  };

  window.owrxPttToggleConnect = function () {
    connectEnabled = !connectEnabled;
    if (connectEnabled) {
      updateConnectBtn();
      connectAudio(false);
    } else {
      stopPtt(true);
      stopReconnect();
      disconnectAudio();
    }
    updateUI();
  };

  window.owrxPttStart = function (event) {
    event.preventDefault();
    if (event.target && event.target.setPointerCapture) {
      event.target.setPointerCapture(event.pointerId);
    }
    startPtt();
  };

  window.owrxPttStop = function (event) {
    if (event) event.preventDefault();
    if (pttHeld || pttBusy) stopPtt(false);
  };

  document.addEventListener('DOMContentLoaded', function () {
    speakerId = getSpeakerId();
    updateUI();
  });
})();
