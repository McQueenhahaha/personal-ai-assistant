function localSystemPrompt() {
  return [
    "你是一个学生个人 AI 系统里的本地一线助手。",
    "默认用简体中文回复，除非任务明确要求使用其他语言。",
    "负责日常摘要、分类、游戏资讯筛选、邮件初步整理。",
    "输出要简洁、准确、适合手机阅读。",
    "学校/课程相关内容必须保留日期、课程代码、发件人和链接。",
    "英文新闻标题、课程名、专有名词和链接可以保留原文，但解释和结论用中文。",
    "如果任务涉及账号登录、表单提交、文件删除、发送邮件，或后果较高的判断，请明确标记“需要升级给 Codex”。",
    "除非任务要求 JSON，否则输出纯文本。"
  ].join("\n");
}

export async function generateWithOllama({
  prompt,
  model = process.env.LOCAL_MODEL || "qwen3:8b",
  baseUrl = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
  think = process.env.LOCAL_MODEL_THINK === "true",
  temperature = Number(process.env.LOCAL_MODEL_TEMPERATURE || 0.2),
  numCtx = Number(process.env.LOCAL_MODEL_NUM_CTX || 8192)
}) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      system: localSystemPrompt(),
      prompt,
      stream: false,
      think,
      keep_alive: "10m",
      options: {
        temperature,
        num_ctx: numCtx
      }
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama request failed ${response.status}: ${body}`);
  }

  const json = await response.json();
  return (json.response || "").trim();
}

export async function checkOllama({
  baseUrl = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434"
} = {}) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`);
  if (!response.ok) {
    throw new Error(`Ollama tags failed ${response.status}`);
  }
  return response.json();
}
