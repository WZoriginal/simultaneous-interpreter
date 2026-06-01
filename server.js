const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const os = require("os");

const PORT = Number(process.env.PORT || 5423);
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_BYTES = 1024 * 1024;
const DASHSCOPE_REALTIME_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
const LOG_FILE = path.join(__dirname, "server.log");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon"
};

function logError(error) {
  const message = error instanceof Error ? `${error.stack || error.message}` : String(error);
  fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`, () => {});
}

process.on("uncaughtException", (error) => {
  logError(error);
});

process.on("unhandledRejection", (reason) => {
  logError(reason);
});

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function safeJoin(base, requestedPath) {
  const decodedPath = decodeURIComponent(requestedPath.split("?")[0]);
  const normalized = decodedPath === "/" ? "/index.html" : decodedPath;
  const target = path.normalize(path.join(base, normalized));
  return target.startsWith(base) ? target : null;
}

function buildPrompt({ sourceLang, targetLang, tone, glossary, text }) {
  const glossaryBlock = glossary
    ? `\n术语表/人名/专有名词：\n${glossary}\n请优先遵守这些译法。`
    : "";

  return [
    {
      role: "system",
      content:
        "你是专业同声传译员。只输出译文，不解释、不添加引号、不保留原文。译文应自然、准确、适合实时口播。"
    },
    {
      role: "user",
      content:
        `请把下面这段${sourceLang || "自动识别语言"}内容翻译成${targetLang || "中文"}。` +
        `语气：${tone || "自然、清晰、口语化"}。` +
        glossaryBlock +
        `\n\n原文：\n${text}`
    }
  ];
}

function getChatEndpoint(baseUrl) {
  const endpoint = new URL(String(baseUrl || "").trim());
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");

  if (!endpoint.pathname || endpoint.pathname === "/") {
    endpoint.pathname = "/compatible-mode/v1";
  }

  if (!endpoint.pathname.endsWith("/chat/completions")) {
    endpoint.pathname = path.posix.join(endpoint.pathname, "chat/completions");
  }

  return endpoint;
}

async function requestChatCompletion({ endpoint, apiKey, model, messages }) {
  const upstream = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: 800
    })
  });

  const rawBody = await upstream.text();
  let data = {};
  try {
    data = rawBody ? JSON.parse(rawBody) : {};
  } catch (error) {
    data = {};
  }

  return { upstream, rawBody, data };
}

async function translate(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (error) {
    sendJson(res, 400, { error: "无法解析请求内容。" });
    return;
  }

  const {
    apiKey,
    baseUrl = "https://api.openai.com/v1",
    model = "gpt-4o-mini",
    sourceLang,
    targetLang,
    tone,
    glossary,
    text
  } = payload;

  if (!apiKey || !String(apiKey).trim()) {
    sendJson(res, 400, { error: "请先填写 API Key。" });
    return;
  }

  if (!text || !String(text).trim()) {
    sendJson(res, 400, { error: "没有可翻译的内容。" });
    return;
  }

  let endpoint;
  try {
    endpoint = getChatEndpoint(baseUrl);
  } catch (error) {
    sendJson(res, 400, { error: "Base URL 格式不正确。" });
    return;
  }

  try {
    const messages = buildPrompt({ sourceLang, targetLang, tone, glossary, text });
    let result = await requestChatCompletion({ endpoint, apiKey, model, messages });

    if (
      result.upstream.status === 404 &&
      endpoint.hostname.includes("dashscope") &&
      model !== "qwen-flash"
    ) {
      result = await requestChatCompletion({ endpoint, apiKey, model: "qwen-flash", messages });
    }

    if (!result.upstream.ok) {
      const message =
        result.data.error?.message ||
        result.data.message ||
        result.rawBody.slice(0, 300) ||
        `模型接口返回 ${result.upstream.status}`;
      sendJson(res, result.upstream.status, { error: message });
      return;
    }

    const translation = result.data.choices?.[0]?.message?.content?.trim();
    if (!translation) {
      sendJson(res, 502, { error: "模型没有返回译文。" });
      return;
    }

    sendJson(res, 200, { translation });
  } catch (error) {
    sendJson(res, 502, { error: `连接模型接口失败：${error.message}` });
  }
}

function getLanguageCode(lang) {
  const map = {
    "zh-CN": "zh",
    "en-US": "en",
    "ja-JP": "ja",
    "ko-KR": "ko",
    "fr-FR": "fr",
    "de-DE": "de",
    "es-ES": "es"
  };
  return map[lang] || "zh";
}

function setupAsrProxy(server) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== "/api/asr") {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      wss.emit("connection", client, req);
    });
  });

  wss.on("connection", (client) => {
    let upstream;
    let configured = false;
    let protocolType = "realtime";
    let taskId = "";

    function sendClient(payload) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(payload));
      }
    }

    function closeUpstream() {
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        if (protocolType === "inference") {
          upstream.send(
            JSON.stringify({
              header: {
                action: "finish-task",
                task_id: taskId,
                streaming: "duplex"
              },
              payload: {}
            })
          );
        } else {
          upstream.send(JSON.stringify({ event_id: `finish_${Date.now()}`, type: "session.finish" }));
        }
        upstream.close(1000, "client closed");
      }
    }

    client.on("message", (message, isBinary) => {
      if (!configured) {
        if (isBinary) {
          sendClient({ type: "error", error: "请先发送 ASR 配置。" });
          return;
        }

        let config;
        try {
          config = JSON.parse(message.toString());
        } catch (error) {
          sendClient({ type: "error", error: "ASR 配置格式错误。" });
          return;
        }

        const apiKey = String(config.apiKey || "").trim();
        const model = String(config.asrModel || "qwen3-asr-flash-realtime").trim();
        let asrBaseUrl = String(config.asrBaseUrl || "wss://dashscope.aliyuncs.com/api-ws/v1/realtime").trim();
        const language = getLanguageCode(config.sourceLang);

        if (!apiKey) {
          sendClient({ type: "error", error: "请先填写 API Key。" });
          return;
        }

        const isParaformer = model.includes("paraformer") || model.includes("funasr");
        protocolType = isParaformer ? "inference" : "realtime";
        taskId = `task_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

        // Auto swap path to /inference or /realtime if standard DashScope host is used and not matching
        if (asrBaseUrl.includes("dashscope.aliyuncs.com") || asrBaseUrl.includes("dashscope-intl.aliyuncs.com")) {
          const urlObj = new URL(asrBaseUrl);
          if (protocolType === "inference" && urlObj.pathname.includes("/realtime")) {
            urlObj.pathname = urlObj.pathname.replace("/realtime", "/inference");
            asrBaseUrl = urlObj.toString();
          } else if (protocolType === "realtime" && urlObj.pathname.includes("/inference")) {
            urlObj.pathname = urlObj.pathname.replace("/inference", "/realtime");
            asrBaseUrl = urlObj.toString();
          }
        }

        let connectUrl = asrBaseUrl;
        let wsHeaders = {
          Authorization: `Bearer ${apiKey}`
        };
        if (protocolType === "realtime") {
          connectUrl = `${asrBaseUrl}?model=${encodeURIComponent(model)}`;
          wsHeaders["OpenAI-Beta"] = "realtime=v1";
        }

        upstream = new WebSocket(connectUrl, {
          headers: wsHeaders
        });

        upstream.on("open", () => {
          configured = true;
          if (protocolType === "inference") {
            upstream.send(
              JSON.stringify({
                header: {
                  action: "run-task",
                  task_id: taskId,
                  streaming: "duplex"
                },
                payload: {
                  task_group: "audio",
                  task: "asr",
                  function: "recognition",
                  model: model,
                  parameters: {
                    format: "pcm",
                    sample_rate: 16000
                  },
                  input: {}
                }
              })
            );
          } else {
            upstream.send(
              JSON.stringify({
                event_id: `session_${Date.now()}`,
                type: "session.update",
                session: {
                  modalities: ["text"],
                  input_audio_format: "pcm",
                  sample_rate: 16000,
                  input_audio_transcription: { language },
                  turn_detection: {
                    type: "server_vad",
                    threshold: 0.2,
                    silence_duration_ms: 500
                  }
                }
              })
            );
          }
          sendClient({ type: "ready" });
        });

        upstream.on("message", (raw) => {
          let data;
          try {
            data = JSON.parse(raw.toString());
          } catch (error) {
            return;
          }

          if (protocolType === "inference") {
            const eventName = data.header?.event;
            const sentence = data.payload?.output?.sentence;
            if (eventName === "result-generated" && sentence) {
              const text = sentence.text || "";
              if (sentence.sentence_end) {
                sendClient({ type: "final", text: text });
              } else {
                sendClient({ type: "partial", text: text });
              }
            } else if (eventName === "task-failed") {
              sendClient({ type: "error", error: data.header?.error_message || "ASR 识别失败。" });
            }
          } else {
            if (data.type === "conversation.item.input_audio_transcription.completed" && data.transcript) {
              sendClient({ type: "final", text: data.transcript });
            } else if (data.type === "conversation.item.input_audio_transcription.delta" && data.delta) {
              sendClient({ type: "partial", text: data.delta });
            } else if (data.type === "error") {
              sendClient({ type: "error", error: data.error?.message || data.message || "ASR 服务错误。" });
            }
          }
        });

        upstream.on("close", () => sendClient({ type: "closed" }));
        upstream.on("error", (error) => sendClient({ type: "error", error: `ASR 连接失败：${error.message}` }));
        return;
      }

      if (!upstream || upstream.readyState !== WebSocket.OPEN) {
        return;
      }

      if (isBinary) {
        if (protocolType === "inference") {
          upstream.send(message);
        } else {
          upstream.send(
            JSON.stringify({
              event_id: `audio_${Date.now()}`,
              type: "input_audio_buffer.append",
              audio: Buffer.from(message).toString("base64")
            })
          );
        }
      } else {
        let data;
        try {
          data = JSON.parse(message.toString());
        } catch (error) {
          return;
        }
        if (data.type === "finish") {
          closeUpstream();
        }
      }
    });

    client.on("error", logError);
    client.on("close", closeUpstream);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/translate") {
    translate(req, res);
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method Not Allowed" });
    return;
  }

  const filePath = safeJoin(PUBLIC_DIR, req.url || "/");
  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[ext] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(content);
  });
});

setupAsrProxy(server);

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const [name, nets] of Object.entries(interfaces)) {
    for (const address of nets || []) {
      if (address.family !== "IPv4" || address.internal) continue;
      if (address.address.startsWith("169.254.")) continue;
      const virtual = /vmware|virtualbox|hyper-v|vethernet|loopback|tap|wsl|docker|npcap/i.test(name);
      addresses.push({
        interface: name,
        address: address.address,
        virtual,
        url: `http://${address.address}:${PORT}`
      });
    }
  }
  return addresses.sort((a, b) => Number(a.virtual) - Number(b.virtual));
}

server.listen(PORT, "0.0.0.0", () => {
  const lanAddresses = getLanAddresses();
  console.log(`========================================`);
  console.log(`  Simultaneous Interpreter Running at:`);
  console.log(`  Local:   http://127.0.0.1:${PORT}`);
  for (const item of lanAddresses) {
    const label = item.virtual ? "Virtual" : "LAN";
    console.log(`  ${label}:     ${item.url} (${item.interface})`);
  }
  console.log(`========================================`);
  
  // Heartbeat to prevent sandbox termination
  setInterval(() => {
    console.log(`[Interpreter Heartbeat] Server is active: ${new Date().toISOString()}`);
  }, 30000);
});
