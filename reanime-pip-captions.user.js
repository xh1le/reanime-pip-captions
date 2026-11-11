// ==UserScript==
// @name         ReAnime PiP Captions
// @namespace    https://reanime.to/
// @version      1.3.0
// @description  Keep the player's live captions in Picture-in-Picture, including size, timing, language and quality.
// @match        https://reanime.to/*
// @match        https://*.reanime.to/*
// @match        https://flixcloud.cc/*
// @match        https://*.flixcloud.cc/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==

/*
 * ReAnime draws captions on a canvas over the video (PGS, libass, or HTML).
 * Chrome's PiP window only shows the <video>, so the site's PiP button drops
 * them. The player itself is a flixcloud iframe, and Document PiP cannot be
 * opened from an iframe, so this hooks that button and feeds PiP a video
 * stream with the current frame and the live caption layer painted in.
 *
 * Size, offset, language and quality stay in sync because every frame copies
 * the layer the player is already rendering, not a saved setting.
 *
 * On reanime.to the script only makes sure the embed is allowed to open PiP.
 * It has to run at document-start: libpgs sends its canvas to a worker if
 * transferControlToOffscreen exists, and a transferred canvas cannot be read.
 */
(function () {
  'use strict';

  if (window.__reanimePipCaptions) return;
  window.__reanimePipCaptions = true;

  var host = location.hostname;
  if (/(^|\.)reanime\.to$/i.test(host)) {
    armEmbeds();
    return;
  }
  if (!/(^|\.)flixcloud\.cc$/i.test(host)) return;

  var state = {
    active: false,
    opening: false,
    lastError: '',
    frames: 0,
    scale: 1,
    source: null,
    sink: null,
    canvas: null,
    ctx: null,
    stream: null,
    audioMode: '',
    audioCtx: null,
    mediaNode: null,
    audioDest: null,
    gain: null,
    clockOsc: null,
    clockNode: null,
    clockGain: null,
    rvfc: 0,
    timer: 0,
    wasMuted: false,
    forcedMute: false,
    savedVolume: 1,
    volLock: false,
    playLock: false,
    transferDisabled: false,
    needsStream: false,
  };
  window.__reanimePip = state;

  disableOffscreenTransfer();

  var origRequest = HTMLVideoElement.prototype.requestPictureInPicture;
  if (!origRequest) return;

  HTMLVideoElement.prototype.requestPictureInPicture = function () {
    if (this.dataset.pipSink === '1') return origRequest.apply(this, arguments);
    if (!artVideo(this)) return origRequest.apply(this, arguments);
    if (state.active && state.source === this) {
      return exitPip();
    }
    return open(this);
  };

  function disableOffscreenTransfer() {
    var proto = HTMLCanvasElement.prototype;
    if (typeof proto.transferControlToOffscreen !== 'function') {
      state.transferDisabled = true;
      return;
    }
    try {
      Object.defineProperty(proto, 'transferControlToOffscreen', {
        configurable: true,
        writable: true,
        value: undefined,
      });
    } catch (err) {
      try { proto.transferControlToOffscreen = undefined; } catch (err2) {}
    }
    state.transferDisabled = typeof proto.transferControlToOffscreen !== 'function';
    if (!state.transferDisabled) state.lastError = 'could not keep caption canvas readable';
  }

  function artVideo(video) {
    if (!video || video.dataset.pipSink === '1') return false;
    return video.classList.contains('art-video') || !!video.closest('#artplayer-app, .art-video-player');
  }

  function liveVideo() {
    var current = state.source;
    if (current && current.isConnected) return current;
    return document.querySelector('video.art-video') || document.querySelector('.art-video-player video');
  }

  function readScale(el) {
    if (!el) return 1;
    var inline = el.style && el.style.transform;
    if (inline) {
      var inlineMatch = inline.match(/scale\(\s*([0-9.]+)\s*\)/);
      if (inlineMatch) return parseFloat(inlineMatch[1]) || 1;
    }
    var computed = getComputedStyle(el).transform;
    if (!computed || computed === 'none') return 1;
    var matrix = computed.match(/matrix\(\s*([0-9.eE+-]+)/);
    return matrix ? parseFloat(matrix[1]) || 1 : 1;
  }

  function overlayVisible(el) {
    if (!el || el.width < 2 || el.height < 2) return false;
    var cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) !== 0;
  }

  function videoRect(video, bw, bh) {
    var vw = video.videoWidth || 16;
    var vh = video.videoHeight || 9;
    var fit = Math.min(bw / vw, bh / vh);
    var dw = Math.max(2, Math.round(vw * fit));
    var dh = Math.max(2, Math.round(vh * fit));
    return {
      x: Math.round((bw - dw) / 2),
      y: Math.round((bh - dh) / 2),
      w: dw,
      h: dh,
    };
  }

  function drawOverlay(ctx, overlay, video, rect) {
    if (!overlayVisible(overlay)) return;
    var scale = readScale(overlay);
    state.scale = scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.clip();
    if (Math.abs(scale - 1) >= 0.01) {
      var ox = rect.x + rect.w / 2;
      var oy = rect.y + rect.h;
      ctx.translate(ox, oy);
      ctx.scale(scale, scale);
      ctx.translate(-ox, -oy);
    }
    var videoAspect = video.videoWidth / video.videoHeight;
    var overlayAspect = overlay.width / overlay.height;
    if (!videoAspect || Math.abs(overlayAspect - videoAspect) < 0.08) {
      ctx.drawImage(overlay, rect.x, rect.y, rect.w, rect.h);
    } else {
      var player = overlay.closest('.art-video-player') || overlay.parentElement;
      var pw = player.clientWidth || overlay.clientWidth || overlay.width;
      var ph = player.clientHeight || overlay.clientHeight || overlay.height;
      var fit = Math.min(pw / video.videoWidth, ph / video.videoHeight);
      var vw = video.videoWidth * fit;
      var vh = video.videoHeight * fit;
      var sx = ((pw - vw) / 2 / pw) * overlay.width;
      var sy = ((ph - vh) / 2 / ph) * overlay.height;
      var sw = (vw / pw) * overlay.width;
      var sh = (vh / ph) * overlay.height;
      ctx.drawImage(overlay, sx, sy, sw, sh, rect.x, rect.y, rect.w, rect.h);
    }
    ctx.restore();
  }

  function drawText(ctx, video, rect) {
    var el = document.querySelector('.art-subtitle');
    if (!el) return;
    var player = el.closest('.art-video-player');
    if (player && !player.classList.contains('art-subtitle-show')) return;
    var text = (el.innerText || '').replace(/\u00a0/g, ' ').trim();
    if (!text) return;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
    var scale = readScale(el);
    state.scale = scale;
    var playerW = (player && player.clientWidth) || el.clientWidth || rect.w;
    var fontPx = (parseFloat(cs.fontSize) || 24) * (rect.w / playerW) * scale;
    if (!isFinite(fontPx) || fontPx < 8) fontPx = Math.max(16, rect.h * 0.045 * scale);
    var playerH = (player && player.clientHeight) || rect.h;
    var bottomPx = parseFloat(cs.bottom);
    var bottomRatio = isFinite(bottomPx) && playerH ? bottomPx / playerH : 0.08;
    var lines = text.split(/\n+/).map(function (line) { return line.trim(); }).filter(Boolean);
    if (!lines.length) return;

    ctx.save();
    ctx.font = '700 ' + fontPx + 'px ' + (cs.fontFamily || 'sans-serif');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = Math.max(2, fontPx / 10);
    ctx.strokeStyle = 'rgba(0,0,0,0.92)';
    ctx.fillStyle = cs.color && cs.color !== 'rgba(0, 0, 0, 0)' ? cs.color : '#fff';
    var lineH = fontPx * 1.28;
    var y = rect.y + rect.h - bottomRatio * rect.h;
    for (var i = lines.length - 1; i >= 0; i--) {
      ctx.strokeText(lines[i], rect.x + rect.w / 2, y);
      ctx.fillText(lines[i], rect.x + rect.w / 2, y);
      y -= lineH;
    }
    ctx.restore();
  }

  function ensureCanvas(video) {
    var canvas = state.canvas;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.dataset.pipSink = '1';
      canvas.style.cssText = 'position:fixed;left:-8000px;top:0;width:1920px;height:1080px;opacity:1;pointer-events:none';
      document.documentElement.appendChild(canvas);
      state.canvas = canvas;
      state.ctx = canvas.getContext('2d', { alpha: false });
    }
    var w = video.videoWidth || 1280;
    var h = video.videoHeight || 720;
    var cap = 1920;
    if (w > cap) {
      h = Math.round(h * cap / w);
      w = cap;
    }
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      state.needsStream = true;
    }
    return canvas;
  }

  function paint() {
    var video = liveVideo();
    var canvas = state.canvas;
    var ctx = state.ctx;
    if (!state.active || !video || !canvas || !ctx) return;
    if (video.readyState < 2) return;
    ensureCanvas(video);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    var rect = videoRect(video, canvas.width, canvas.height);
    try {
      ctx.drawImage(video, rect.x, rect.y, rect.w, rect.h);
    } catch (err) {
      state.lastError = String(err && err.message || err);
    }
    var layers = document.querySelectorAll(
      '.artplayer-plugin-libass canvas, .artplayer-plugin-pgs-canvas, .libassjs-canvas'
    );
    for (var i = 0; i < layers.length; i++) {
      try {
        drawOverlay(ctx, layers[i], video, rect);
      } catch (err) {
        state.lastError = String(err && err.message || err);
      }
    }
    try {
      drawText(ctx, video, rect);
    } catch (err) {
      state.lastError = String(err && err.message || err);
    }
    state.frames++;
    pushFrame();
  }

  function pushFrame() {
    if (state.needsStream && state.canvas && state.sink) {
      bindStream(state.canvas);
    }
    var track = state.stream && state.stream.getVideoTracks && state.stream.getVideoTracks()[0];
    if (track && track.requestFrame) {
      try { track.requestFrame(); } catch (err) {}
    }
  }

  function bindStream(canvas) {
    var stream = canvas.captureStream(0);
    var previous = state.stream;
    if (previous) {
      previous.getAudioTracks().forEach(function (track) {
        try { stream.addTrack(track); } catch (err) {}
      });
      previous.getVideoTracks().forEach(function (track) {
        try { track.stop(); } catch (err) {}
      });
    }
    state.stream = stream;
    state.needsStream = false;
    if (state.sink && state.sink.srcObject !== stream) {
      state.sink.srcObject = stream;
      if (state.active) state.sink.play().catch(function () {});
    }
    return stream;
  }
  state.paint = paint;

  function pump() {
    if (!state.active) return;
    paint();
    var video = state.source;
    if (video && video.requestVideoFrameCallback) {
      state.rvfc = video.requestVideoFrameCallback(pump);
    }
  }

  function startClock() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(function () {
      if (!state.active) return;
      paint();
    }, 34);
    var ctx = state.audioCtx;
    if (!ctx || state.clockNode || !ctx.createScriptProcessor) return;
    try {
      var node = ctx.createScriptProcessor(2048, 1, 1);
      var last = 0;
      node.onaudioprocess = function () {
        var now = performance.now();
        if (!state.active || now - last < 30) return;
        last = now;
        paint();
      };
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      gain.gain.value = 0.00001;
      osc.frequency.value = 1;
      osc.connect(node);
      node.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      state.clockNode = node;
      state.clockOsc = osc;
      state.clockGain = gain;
    } catch (err) {
      state.lastError = String(err && err.message || err);
    }
  }

  function stopClock() {
    var video = state.source;
    if (video && video.cancelVideoFrameCallback && state.rvfc) {
      try { video.cancelVideoFrameCallback(state.rvfc); } catch (err) {}
    }
    state.rvfc = 0;
    if (state.timer) clearInterval(state.timer);
    state.timer = 0;
    try { if (state.clockOsc) state.clockOsc.stop(); } catch (err) {}
    try { if (state.clockNode) state.clockNode.disconnect(); } catch (err) {}
    try { if (state.clockGain) state.clockGain.disconnect(); } catch (err) {}
    state.clockOsc = null;
    state.clockNode = null;
    state.clockGain = null;
  }

  function attachAudio(video, stream) {
    state.wasMuted = video.muted;
    state.savedVolume = video.volume;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx && !state.mediaNode) {
      try {
        if (!state.audioCtx) state.audioCtx = new Ctx({ latencyHint: 'playback' });
        state.mediaNode = state.audioCtx.createMediaElementSource(video);
      } catch (err) {
        state.mediaNode = null;
        state.lastError = String(err && err.message || err);
      }
    }
    if (state.mediaNode && state.audioCtx) {
      state.audioMode = 'webaudio';
      var ctx = state.audioCtx;
      if (ctx.state === 'suspended') ctx.resume();
      try { state.mediaNode.disconnect(); } catch (err) {}
      state.audioDest = ctx.createMediaStreamDestination();
      state.gain = ctx.createGain();
      state.gain.gain.value = 1;
      state.mediaNode.connect(state.gain);
      state.gain.connect(state.audioDest);
      state.audioDest.stream.getAudioTracks().forEach(function (track) {
        stream.addTrack(track);
      });
      if (video.muted) video.muted = false;
      video.volume = 1;
      return;
    }
    try {
      var captured = video.captureStream();
      captured.getAudioTracks().forEach(function (track) { stream.addTrack(track); });
      state.audioMode = 'capture';
      state.forcedMute = true;
      video.muted = true;
    } catch (err) {
      state.audioMode = 'none';
      state.lastError = String(err && err.message || err);
    }
  }

  function restoreAudio(video) {
    if (state.audioMode === 'webaudio' && state.mediaNode && state.audioCtx) {
      try { state.mediaNode.disconnect(); } catch (err) {}
      try { state.mediaNode.connect(state.audioCtx.destination); } catch (err) {}
    }
    if (!video) return;
    state.volLock = true;
    if (state.audioMode === 'webaudio') video.volume = state.savedVolume;
    if (state.forcedMute) video.muted = state.wasMuted;
    state.volLock = false;
    state.forcedMute = false;
    state.audioMode = '';
    state.audioDest = null;
    state.gain = null;
  }

  function bindTransport(video, sink) {
    sink.addEventListener('play', function () {
      if (state.playLock || !state.active) return;
      state.playLock = true;
      if (video.paused) video.play().catch(function () {});
      state.playLock = false;
    });
    sink.addEventListener('pause', function () {
      if (state.playLock || !state.active) return;
      if (document.pictureInPictureElement !== sink && !sink.paused) return;
      state.playLock = true;
      if (!video.paused) video.pause();
      state.playLock = false;
    });
    video.addEventListener('play', function () {
      if (state.playLock || !state.active) return;
      state.playLock = true;
      if (sink.paused) sink.play().catch(function () {});
      state.playLock = false;
    });
    video.addEventListener('pause', function () {
      if (state.playLock || !state.active) return;
      state.playLock = true;
      if (!sink.paused) sink.pause();
      state.playLock = false;
    });
    video.addEventListener('volumechange', function () {
      if (state.volLock || !state.active || state.audioMode !== 'webaudio') return;
      state.volLock = true;
      sink.muted = video.muted;
      if (!video.muted && Math.abs(video.volume - 1) > 0.01) {
        sink.volume = video.volume;
        video.volume = 1;
      }
      state.volLock = false;
    });
    sink.addEventListener('enterpictureinpicture', function () {
      try { video.dispatchEvent(new Event('enterpictureinpicture')); } catch (err) {}
    });
    sink.addEventListener('leavepictureinpicture', function () {
      try { video.dispatchEvent(new Event('leavepictureinpicture')); } catch (err) {}
      cleanup();
    });
  }

  function armMediaKeys(video) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: document.title || 'ReAnime',
        artist: 'ReAnime',
      });
    } catch (err) {}
    function seekBy(delta) {
      var end = isFinite(video.duration) ? video.duration : video.currentTime + Math.max(delta, 0);
      video.currentTime = Math.min(end, Math.max(0, video.currentTime + delta));
    }
    try {
      navigator.mediaSession.setActionHandler('play', function () { video.play(); });
      navigator.mediaSession.setActionHandler('pause', function () { video.pause(); });
      navigator.mediaSession.setActionHandler('seekbackward', function () { seekBy(-10); });
      navigator.mediaSession.setActionHandler('seekforward', function () { seekBy(10); });
    } catch (err) {}
  }

  function clearMediaKeys() {
    if (!('mediaSession' in navigator)) return;
    ['play', 'pause', 'seekbackward', 'seekforward'].forEach(function (name) {
      try { navigator.mediaSession.setActionHandler(name, null); } catch (err) {}
    });
  }

  function cleanup() {
    if (!state.active && !state.sink) return;
    state.active = false;
    stopClock();
    var video = state.source;
    var sink = state.sink;
    restoreAudio(video);
    clearMediaKeys();
    if (state.stream) {
      state.stream.getTracks().forEach(function (track) {
        try { track.stop(); } catch (err) {}
      });
    }
    state.stream = null;
    if (sink) {
      sink.pause();
      sink.srcObject = null;
      if (sink.parentNode) sink.parentNode.removeChild(sink);
    }
    state.sink = null;
    if (state.canvas && state.canvas.parentNode) state.canvas.parentNode.removeChild(state.canvas);
    state.canvas = null;
    state.ctx = null;
    state.needsStream = false;
  }

  function exitPip() {
    var sink = state.sink;
    state.active = false;
    var pending = Promise.resolve();
    if (document.pictureInPictureElement) {
      pending = document.exitPictureInPicture().catch(function () {});
    }
    return pending.then(function () {
      cleanup();
    });
  }

  function open(video) {
    if (state.opening) return Promise.reject(new Error('PiP already opening'));
    state.opening = true;
    state.source = video;
    state.frames = 0;
    state.lastError = '';
    var canvas = ensureCanvas(video);
    var ctx = state.ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    try { ctx.drawImage(video, 0, 0, canvas.width, canvas.height); } catch (err) {}

    var stream = bindStream(canvas);
    attachAudio(video, stream);

    var sink = document.createElement('video');
    sink.dataset.pipSink = '1';
    sink.autoplay = true;
    sink.playsInline = true;
    sink.disablePictureInPicture = false;
    sink.style.cssText = 'position:fixed;left:0;top:0;width:8px;height:8px;opacity:0.02;pointer-events:none;z-index:-1';
    sink.srcObject = stream;
    sink.volume = state.audioMode === 'webaudio' ? state.savedVolume : video.volume;
    document.documentElement.appendChild(sink);
    state.sink = sink;
    bindTransport(video, sink);
    armMediaKeys(video);

    state.active = true;
    paint();
    startClock();
    if (video.requestVideoFrameCallback) state.rvfc = video.requestVideoFrameCallback(pump);

    var played = sink.play();
    if (played && played.catch) played.catch(function () {});
    // The site button's click is a transient gesture. Ask immediately; only
    // wait for play() if the sink is not ready yet.
    function requestSink() {
      return origRequest.call(sink);
    }
    return requestSink().catch(function (err) {
      if (!err || err.name !== 'InvalidStateError') throw err;
      var again = played && played.then ? played.catch(function () {}) : Promise.resolve();
      return again.then(requestSink);
    }).then(function (pipWindow) {
      state.opening = false;
      return pipWindow;
    }).catch(function (err) {
      state.opening = false;
      state.lastError = String(err && err.message || err);
      cleanup();
      return origRequest.call(video);
    });
  }

  function withPip(allow) {
    allow = allow || '';
    if (/picture-in-picture/i.test(allow)) return allow;
    return (allow ? allow.replace(/;\s*$/, '') + '; ' : '') + 'picture-in-picture';
  }

  function isPlayerFrame(iframe) {
    var src = '';
    try { src = iframe.src || iframe.getAttribute('src') || ''; } catch (err) { return false; }
    return /flixcloud\.cc/i.test(src);
  }

  function armEmbeds() {
    function patch(iframe) {
      if (!iframe || !isPlayerFrame(iframe)) return;
      var allow = iframe.getAttribute('allow') || '';
      if (!/picture-in-picture/i.test(allow)) {
        iframe.setAttribute('allow', withPip(allow));
      }
    }

    var origSet = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      var attr = String(name).toLowerCase();
      if (this && this.tagName === 'IFRAME' && attr === 'allow') {
        var src = this.getAttribute('src') || '';
        if (/flixcloud\.cc/i.test(src) || /flixcloud\.cc/i.test(String(this.src || ''))) {
          value = withPip(value);
        }
      }
      var ret = origSet.apply(this, arguments);
      if (this && this.tagName === 'IFRAME' && attr === 'src' && /flixcloud\.cc/i.test(String(value))) {
        patch(this);
      }
      return ret;
    };

    var allowDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'allow');
    if (allowDesc && allowDesc.set && allowDesc.configurable) {
      Object.defineProperty(HTMLIFrameElement.prototype, 'allow', {
        configurable: true,
        enumerable: allowDesc.enumerable,
        get: allowDesc.get,
        set: function (value) {
          if (isPlayerFrame(this)) value = withPip(value);
          allowDesc.set.call(this, value);
        },
      });
    }
    var srcDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
    if (srcDesc && srcDesc.set && srcDesc.configurable) {
      Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
        configurable: true,
        enumerable: srcDesc.enumerable,
        get: srcDesc.get,
        set: function (value) {
          srcDesc.set.call(this, value);
          if (/flixcloud\.cc/i.test(String(value))) patch(this);
        },
      });
    }

    function scan() {
      var frames = document.querySelectorAll('iframe');
      for (var i = 0; i < frames.length; i++) patch(frames[i]);
    }

    new MutationObserver(scan).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'allow'],
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
    scan();
  }
})();
