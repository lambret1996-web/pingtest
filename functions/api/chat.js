export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const messages = body.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      return json(
        { error: "messages 参数不能为空" },
        400
      );
    }

    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: env.OPENAI_MODEL || "gpt-4o-mini",
          messages: messages.map((item) => ({
            role: item.role,
            content: String(item.content)
          })),
          temperature: 0.7
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("AI API error:", data);

      return json(
        { error: "AI 服务请求失败" },
        500
      );
    }

    const reply =
      data.choices?.[0]?.message?.content ||
      "AI 没有返回内容";

    return json({ reply });
  } catch (error) {
    console.error("Server error:", error);

    return json(
      { error: "服务器处理请求失败" },
      500
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      ...corsHeaders()
    }
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
