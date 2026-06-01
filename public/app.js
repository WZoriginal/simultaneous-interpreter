const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const els = {
  apiKey: document.querySelector("#apiKey"),
  asrApiKey: document.querySelector("#asrApiKey"),
  baseUrl: document.querySelector("#baseUrl"),
  asrBaseUrl: document.querySelector("#asrBaseUrl"),
  asrBaseUrlSelect: document.querySelector("#asrBaseUrlSelect"),
  model: document.querySelector("#model"),
  asrModel: document.querySelector("#asrModel"),
  asrModelSelect: document.querySelector("#asrModelSelect"),
  audioSource: document.querySelector("#audioSource"),
  sourceLang: document.querySelector("#sourceLang"),
  targetLang: document.querySelector("#targetLang"),
  tone: document.querySelector("#tone"),
  glossary: document.querySelector("#glossary"),
  debounceMs: document.querySelector("#debounceMs"),
  debounceValue: document.querySelector("#debounceValue"),
  maxSegmentChars: document.querySelector("#maxSegmentChars"),
  maxSegmentValue: document.querySelector("#maxSegmentValue"),
  startBtn: document.querySelector("#startBtn"),
  stopBtn: document.querySelector("#stopBtn"),
  clearBtn: document.querySelector("#clearBtn"),
  exportBtn: document.querySelector("#exportBtn"),
  autoSpeak: document.querySelector("#autoSpeak"),
  sourceText: document.querySelector("#sourceText"),
  translatedText: document.querySelector("#translatedText"),
  history: document.querySelector("#history"),
  listeningState: document.querySelector("#listeningState"),
  translationState: document.querySelector("#translationState"),
  connectionStatus: document.querySelector("#connectionStatus")
};

let recognition;
let asrSocket;
let audioContext;
let audioProcessor;
let systemAudioStream;
let isStoppingSystemAudio = false;
let isRunning = false;
let finalBuffer = "";
let interimBuffer = "";
let sentenceBuffer = "";
let sentenceTimer;
let translationQueue = [];
let isTranslating = false;
let historyItems = [];
let livePairs = [];

const sentenceEndPattern = /[。！？!?；;.!?]+["'”’）)]*\s*/g;
const minImmediateChars = 8;
const storedConfig = JSON.parse(localStorage.getItem("interpreter-config") || "{}");

for (const [key, value] of Object.entries(storedConfig)) {
  if (key !== "apiKey" && key !== "asrApiKey" && els[key] && typeof value === "string") {
    els[key].value = value;
  }
}

if (Number(els.debounceMs.value) > 700) {
  els.debounceMs.value = "500";
}

els.debounceValue.textContent = `${els.debounceMs.value}ms`;
els.maxSegmentValue.textContent = `${els.maxSegmentChars.value}字符`;

function loadSelectValues() {
  const curBaseUrl = els.asrBaseUrl.value;
  const matchBaseUrl = Array.from(els.asrBaseUrlSelect.options).some(opt => opt.value === curBaseUrl);
  if (matchBaseUrl) {
    els.asrBaseUrlSelect.value = curBaseUrl;
    els.asrBaseUrl.style.display = "none";
  } else {
    els.asrBaseUrlSelect.value = "custom";
    els.asrBaseUrl.style.display = "block";
  }

  const curModel = els.asrModel.value;
  const matchModel = Array.from(els.asrModelSelect.options).some(opt => opt.value === curModel);
  if (matchModel) {
    els.asrModelSelect.value = curModel;
    els.asrModel.style.display = "none";
  } else {
    els.asrModelSelect.value = "custom";
    els.asrModel.style.display = "block";
  }
}

function initSelectSync() {
  els.asrBaseUrlSelect.addEventListener("change", () => {
    if (els.asrBaseUrlSelect.value === "custom") {
      els.asrBaseUrl.style.display = "block";
      els.asrBaseUrl.focus();
    } else {
      els.asrBaseUrl.style.display = "none";
      els.asrBaseUrl.value = els.asrBaseUrlSelect.value;
    }
    saveConfig();
  });

  els.asrModelSelect.addEventListener("change", () => {
    const isParaformer = els.asrModelSelect.value.includes("paraformer") || els.asrModelSelect.value.includes("funasr");
    
    // Automatically adjust the selected Base URL based on model type
    if (els.asrBaseUrlSelect.value !== "custom") {
      const isIntl = els.asrBaseUrlSelect.value.includes("-intl");
      if (isParaformer) {
        els.asrBaseUrlSelect.value = isIntl 
          ? "wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference" 
          : "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
      } else {
        els.asrBaseUrlSelect.value = isIntl 
          ? "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime" 
          : "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
      }
      els.asrBaseUrl.value = els.asrBaseUrlSelect.value;
      els.asrBaseUrl.style.display = "none";
    }

    if (els.asrModelSelect.value === "custom") {
      els.asrModel.style.display = "block";
      els.asrModel.focus();
    } else {
      els.asrModel.style.display = "none";
      els.asrModel.value = els.asrModelSelect.value;
    }
    saveConfig();
  });

  els.asrBaseUrl.addEventListener("input", saveConfig);
  els.asrModel.addEventListener("input", saveConfig);
}

loadSelectValues();
initSelectSync();

function saveConfig() {
  const config = {
    baseUrl: els.baseUrl.value,
    asrBaseUrl: els.asrBaseUrl.value,
    model: els.model.value,
    asrModel: els.asrModel.value,
    audioSource: els.audioSource.value,
    debounceMs: els.debounceMs.value,
    maxSegmentChars: els.maxSegmentChars.value,
    sourceLang: els.sourceLang.value,
    targetLang: els.targetLang.value,
    tone: els.tone.value,
    glossary: els.glossary.value
  };
  localStorage.setItem("interpreter-config", JSON.stringify(config));
}

function setStatus(text, mode = "") {
  els.connectionStatus.textContent = text;
  els.connectionStatus.className = `status-pill ${mode}`.trim();
}

function renderSource() {
  const hasContent = livePairs.length > 0 || Boolean(interimBuffer);
  els.sourceText.innerHTML = "";

  if (!hasContent) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = "选择输入源后点击开始。电脑视频声音模式需要在浏览器共享窗口中勾选音频。";
    els.sourceText.append(empty);
  } else {
    const list = document.createElement("div");
    list.className = "align-list";

    for (const item of livePairs) {
      list.append(createAlignNode(item.id, item.source, "source"));
    }

    if (interimBuffer) {
      list.append(createAlignNode("interim", interimBuffer, "source"));
    }

    els.sourceText.append(list);
  }

  els.sourceText.classList.toggle("muted", !hasContent);
  renderTranslated();
  syncPairHeights();
  scrollToBottom(els.sourceText);
}

function renderTranslated() {
  els.translatedText.innerHTML = "";

  if (livePairs.length === 0) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = "模型返回的译文会实时显示在这里。";
    els.translatedText.append(empty);
    els.translatedText.classList.add("muted");
    return;
  }

  const list = document.createElement("div");
  list.className = "align-list";

  for (const item of livePairs) {
    list.append(createAlignNode(item.id, item.target || "翻译中...", "target", !item.target));
  }

  els.translatedText.classList.remove("muted");
  els.translatedText.append(list);
  scrollToBottom(els.translatedText);
}

function createAlignNode(id, text, type, pending = false) {
  const row = document.createElement("div");
  row.className = "align-item";
  row.dataset.pairId = id;

  const content = document.createElement("p");
  content.className = `${type === "target" ? "align-target" : "align-source"}${pending ? " pending" : ""}`;
  content.textContent = text;

  row.append(content);
  return row;
}

function syncPairHeights() {
  requestAnimationFrame(() => {
    const sourceRows = Array.from(els.sourceText.querySelectorAll(".align-item[data-pair-id]"));
    const targetRows = Array.from(els.translatedText.querySelectorAll(".align-item[data-pair-id]"));

    for (const row of [...sourceRows, ...targetRows]) {
      row.style.removeProperty("--pair-height");
    }

    const targetById = new Map(targetRows.map((row) => [row.dataset.pairId, row]));
    for (const sourceRow of sourceRows) {
      const targetRow = targetById.get(sourceRow.dataset.pairId);
      if (!targetRow) continue;

      const height = Math.max(sourceRow.offsetHeight, targetRow.offsetHeight);
      sourceRow.style.setProperty("--pair-height", `${height}px`);
      targetRow.style.setProperty("--pair-height", `${height}px`);
    }
  });
}

function renderHistory() {
  els.history.innerHTML = "";
  for (const item of historyItems.slice().reverse()) {
    const row = document.createElement("div");
    row.className = "history-item";

    const source = document.createElement("p");
    source.className = "history-source";
    source.textContent = item.source;

    const target = document.createElement("p");
    target.className = "history-target";
    target.textContent = item.target;

    row.append(source, target);
    els.history.append(row);
  }
  scrollToBottom(els.history);
}

function scrollToBottom(element) {
  requestAnimationFrame(() => {
    element.scrollTop = element.scrollHeight;
  });
}

function targetVoiceLang(label) {
  const map = {
    中文: "zh-CN",
    英文: "en-US",
    日文: "ja-JP",
    韩文: "ko-KR",
    法文: "fr-FR",
    德文: "de-DE",
    西班牙文: "es-ES"
  };
  return map[label] || "zh-CN";
}

function speak(text) {
  if (!els.autoSpeak.checked || !("speechSynthesis" in window)) {
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = targetVoiceLang(els.targetLang.value);
  utterance.rate = 1.05;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function normalizeSpeechText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function extractCompleteSentences() {
  const sentences = [];
  let lastIndex = 0;
  sentenceEndPattern.lastIndex = 0;

  for (const match of sentenceBuffer.matchAll(sentenceEndPattern)) {
    const endIndex = match.index + match[0].length;
    const sentence = sentenceBuffer.slice(lastIndex, endIndex).trim();
    if (sentence) {
      sentences.push(sentence);
    }
    lastIndex = endIndex;
  }

  sentenceBuffer = sentenceBuffer.slice(lastIndex).trim();
  sentences.push(...extractLongSegments());
  return sentences;
}

function extractLongSegments() {
  const maxLength = Number(els.maxSegmentChars.value || 90);
  const segments = [];

  while (sentenceBuffer.length >= maxLength) {
    let cutIndex = findSoftCutIndex(sentenceBuffer, maxLength);
    if (cutIndex <= 0) {
      cutIndex = maxLength;
    }

    const segment = sentenceBuffer.slice(0, cutIndex).trim();
    if (segment) {
      segments.push(segment);
    }
    sentenceBuffer = sentenceBuffer.slice(cutIndex).trim();
  }

  return segments;
}

function findSoftCutIndex(text, maxLength) {
  const windowStart = Math.max(0, maxLength - 35);
  const searchArea = text.slice(windowStart, maxLength + 1);
  const separators = ["，", ",", "、", "：", ":", " "];

  for (const separator of separators) {
    const index = searchArea.lastIndexOf(separator);
    if (index > 0) {
      return windowStart + index + separator.length;
    }
  }

  return maxLength;
}

function addRecognizedFinalText(text) {
  const cleanText = normalizeSpeechText(text);
  if (!cleanText) return;

  finalBuffer = `${finalBuffer}\n${cleanText}`.trim();
  sentenceBuffer = `${sentenceBuffer} ${cleanText}`.trim();

  const completeSentences = extractCompleteSentences();
  for (const sentence of completeSentences) {
    if (shouldTranslateImmediately(sentence)) {
      enqueueTranslation(sentence);
    } else {
      sentenceBuffer = `${sentenceBuffer} ${sentence}`.trim();
    }
  }

  scheduleTrailingSentence();
}

function shouldTranslateImmediately(text) {
  const compact = text.replace(/\s+/g, "");
  if (/[\u4e00-\u9fff]/.test(compact)) {
    return compact.length >= 4;
  }
  return compact.length >= minImmediateChars || /\s/.test(text.replace(/[.!?。！？；;]+$/g, "").trim());
}

function addInterimText(text) {
  interimBuffer = normalizeSpeechText(text);
  renderSource();
}

function scheduleTrailingSentence() {
  clearTimeout(sentenceTimer);
  const delay = Number(els.debounceMs.value);
  sentenceTimer = setTimeout(() => {
    const text = sentenceBuffer.trim();
    if (!text) return;
    sentenceBuffer = "";
    enqueueTranslation(text);
  }, delay);
}

function enqueueTranslation(text) {
  const cleanText = normalizeSpeechText(text);
  if (!cleanText) return;

  const pair = { id: `pair-${Date.now()}-${Math.random().toString(16).slice(2)}`, source: cleanText, target: "" };
  livePairs.push(pair);
  renderSource();
  translationQueue.push(pair);
  processTranslationQueue();
}

async function processTranslationQueue() {
  if (isTranslating || translationQueue.length === 0) {
    return;
  }

  isTranslating = true;
  const pair = translationQueue.shift();

  try {
    await translate(pair);
  } finally {
    isTranslating = false;
    if (translationQueue.length > 0) {
      processTranslationQueue();
    }
  }
}

async function translate(pair) {
  const text = pair.source;
  saveConfig();
  els.translationState.textContent = "翻译中";
  setStatus("翻译中", "active");

  try {
    const response = await fetch("/api/translate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        apiKey: els.apiKey.value,
        baseUrl: els.baseUrl.value,
        model: els.model.value,
        sourceLang: els.sourceLang.options[els.sourceLang.selectedIndex].text,
        targetLang: els.targetLang.value,
        tone: els.tone.value,
        glossary: els.glossary.value,
        text
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "翻译失败");
    }

    pair.target = data.translation;
    renderSource();
    els.translationState.textContent = "已更新";
    setStatus(isRunning ? "监听中" : "已停止", isRunning ? "active" : "");
    historyItems.push({ source: text, target: data.translation });
    renderHistory();
    speak(data.translation);
  } catch (error) {
    els.translationState.textContent = "出错";
    setStatus("接口错误", "error");
    els.translatedText.textContent = error.message;
  }
}

function createRecognition() {
  if (!SpeechRecognition) {
    setStatus("不支持", "error");
    els.sourceText.textContent = "当前浏览器不支持 Web Speech API。请使用 Chrome 或 Edge 打开。";
    els.startBtn.disabled = true;
    return null;
  }

  const instance = new SpeechRecognition();
  instance.continuous = true;
  instance.interimResults = true;
  instance.lang = els.sourceLang.value;

  instance.onstart = () => {
    isRunning = true;
    els.startBtn.disabled = true;
    els.stopBtn.disabled = false;
    els.listeningState.textContent = "正在识别";
    setStatus("监听中", "active");
  };

  instance.onresult = (event) => {
    interimBuffer = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const transcript = event.results[i][0].transcript;
      if (!transcript.trim()) continue;

      if (event.results[i].isFinal) {
        addRecognizedFinalText(transcript);
      } else {
        interimBuffer = normalizeSpeechText(transcript);
      }
    }
    renderSource();
  };

  instance.onerror = (event) => {
    els.listeningState.textContent = "识别错误";
    setStatus(event.error || "识别错误", "error");
  };

  instance.onend = () => {
    if (isRunning) {
      try {
        instance.start();
      } catch (error) {
        setStatus("重启识别中", "active");
      }
      return;
    }
    els.startBtn.disabled = false;
    els.stopBtn.disabled = true;
    els.listeningState.textContent = "已停止";
    setStatus("已停止");
  };

  return instance;
}

function floatTo16BitPcm(float32Samples) {
  const pcm = new Int16Array(float32Samples.length);
  for (let i = 0; i < float32Samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32Samples[i]));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm;
}

function downsampleTo16k(samples, sourceRate) {
  if (sourceRate === 16000) {
    return samples;
  }

  const ratio = sourceRate / 16000;
  const outputLength = Math.floor(samples.length / ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), samples.length);
    let sum = 0;
    let count = 0;

    for (let j = start; j < end; j += 1) {
      sum += samples[j];
      count += 1;
    }

    output[i] = count ? sum / count : 0;
  }

  return output;
}

function stopSystemAudioRecognition() {
  if (isStoppingSystemAudio) {
    return;
  }

  isStoppingSystemAudio = true;

  if (audioProcessor) {
    audioProcessor.disconnect();
    audioProcessor.onaudioprocess = null;
    audioProcessor = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (systemAudioStream) {
    systemAudioStream.getTracks().forEach((track) => track.stop());
    systemAudioStream = null;
  }
  if (asrSocket && asrSocket.readyState === WebSocket.OPEN) {
    asrSocket.send(JSON.stringify({ type: "finish" }));
    asrSocket.close();
  }
  asrSocket = null;
  isStoppingSystemAudio = false;
}

async function startSystemAudioRecognition() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    setStatus("不支持系统音频", "error");
    els.sourceText.textContent = "当前浏览器不支持屏幕/窗口音频采集。请使用 Chrome 或 Edge。";
    return;
  }

  els.listeningState.textContent = "选择音频来源";
  setStatus("选择窗口", "active");

  systemAudioStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  });

  const audioTracks = systemAudioStream.getAudioTracks();
  if (audioTracks.length === 0) {
    stopSystemAudioRecognition();
    throw new Error("没有捕获到电脑声音。请重新开始，并在共享窗口里勾选“共享音频”。");
  }

  asrSocket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/asr`);
  asrSocket.binaryType = "arraybuffer";

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ASR 连接超时。")), 10000);

    asrSocket.onopen = () => {
      asrSocket.send(
        JSON.stringify({
          apiKey: els.asrApiKey.value.trim() || els.apiKey.value.trim(),
          asrBaseUrl: els.asrBaseUrl.value.trim(),
          asrModel: els.asrModel.value,
          sourceLang: els.sourceLang.value
        })
      );
    };

    asrSocket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "ready") {
        clearTimeout(timer);
        resolve();
      } else if (data.type === "partial") {
        addInterimText(data.text);
      } else if (data.type === "final") {
        interimBuffer = "";
        addRecognizedFinalText(data.text);
        renderSource();
      } else if (data.type === "error") {
        clearTimeout(timer);
        reject(new Error(data.error || "ASR 服务错误。"));
      }
    };

    asrSocket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("ASR WebSocket 连接失败。"));
    };
  });

  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(systemAudioStream);
  audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);

  audioProcessor.onaudioprocess = (event) => {
    if (!asrSocket || asrSocket.readyState !== WebSocket.OPEN) {
      return;
    }

    const input = event.inputBuffer.getChannelData(0);
    const downsampled = downsampleTo16k(input, audioContext.sampleRate);
    const pcm = floatTo16BitPcm(downsampled);
    asrSocket.send(pcm.buffer);
  };

  source.connect(audioProcessor);
  audioProcessor.connect(audioContext.destination);

  const handleTrackEnded = () => {
    if (isRunning) {
      stop();
    }
  };

  systemAudioStream.getVideoTracks().forEach((track) => {
    track.onended = handleTrackEnded;
  });
  systemAudioStream.getAudioTracks().forEach((track) => {
    track.onended = handleTrackEnded;
  });

  isRunning = true;
  els.startBtn.disabled = true;
  els.stopBtn.disabled = false;
  els.listeningState.textContent = "正在识别电脑声音";
  setStatus("系统音频中", "active");
}

function start() {
  if (!els.apiKey.value.trim()) {
    setStatus("缺少 Key", "error");
    els.apiKey.focus();
    return;
  }

  saveConfig();
  clearTimeout(sentenceTimer);
  sentenceBuffer = "";
  interimBuffer = "";

  if (els.audioSource.value === "system") {
    startSystemAudioRecognition().catch((error) => {
      stopSystemAudioRecognition();
      isRunning = false;
      els.startBtn.disabled = false;
      els.stopBtn.disabled = true;
      els.listeningState.textContent = "未开始";
      setStatus("采集失败", "error");
      els.sourceText.textContent = error.message;
    });
    return;
  }

  recognition = createRecognition();
  if (!recognition) return;
  recognition.lang = els.sourceLang.value;
  recognition.start();
}

function stop() {
  isRunning = false;
  clearTimeout(sentenceTimer);
  if (recognition) {
    recognition.stop();
  }
  stopSystemAudioRecognition();
  if (sentenceBuffer.trim()) {
    const text = sentenceBuffer.trim();
    sentenceBuffer = "";
    enqueueTranslation(text);
  }
}

function clearAll() {
  finalBuffer = "";
  interimBuffer = "";
  sentenceBuffer = "";
  translationQueue = [];
  historyItems = [];
  livePairs = [];
  clearTimeout(sentenceTimer);
  stopSystemAudioRecognition();
  window.speechSynthesis?.cancel();
  renderSource();
  renderHistory();
  els.translatedText.textContent = "模型返回的译文会实时显示在这里。";
  els.translatedText.classList.add("muted");
  els.translationState.textContent = "等待语音";
}

function exportText() {
  const content = historyItems
    .map((item, index) => `#${index + 1}\n原文：${item.source}\n译文：${item.target}`)
    .join("\n\n");
  const blob = new Blob([content || "暂无传译记录"], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `interpretation-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

for (const input of [
  els.baseUrl,
  els.asrBaseUrl,
  els.model,
  els.asrModel,
  els.audioSource,
  els.sourceLang,
  els.targetLang,
  els.tone,
  els.glossary,
  els.maxSegmentChars
]) {
  input.addEventListener("change", saveConfig);
}

els.debounceMs.addEventListener("input", () => {
  els.debounceValue.textContent = `${els.debounceMs.value}ms`;
  saveConfig();
});
els.maxSegmentChars.addEventListener("input", () => {
  els.maxSegmentValue.textContent = `${els.maxSegmentChars.value}字符`;
  saveConfig();
});
els.startBtn.addEventListener("click", start);
els.stopBtn.addEventListener("click", stop);
els.clearBtn.addEventListener("click", clearAll);
els.exportBtn.addEventListener("click", exportText);

if (!SpeechRecognition) {
  createRecognition();
}
