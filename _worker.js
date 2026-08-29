export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const kv = env.KV;

    // 1. 访问统计接口
    if (url.pathname === "/visit") {
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const today = new Date().toISOString().slice(0, 10);
      const totalKey = "visit:total_visit";
      const dayKey = `visit:day:${today}`;
      const ipKey = `visit:ip:${ip}`;

      let total = Number(await kv.get(totalKey)) || 0;
      total += 1;
      await kv.put(totalKey, String(total));

      let dayCnt = Number(await kv.get(dayKey)) || 0;
      dayCnt += 1;
      await kv.put(dayKey, String(dayCnt));

      const existIp = await kv.get(ipKey);
      if (!existIp) {
        await kv.put(ipKey, "1", { expirationTtl: 86400 * 30 });
      }

      return Response.json({ total, today: dayCnt });
    }

    // 2. 保存优质测速记录
    if (url.pathname === "/save") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      const body = await request.json();
      const { name, testUrl, ms, loss } = body;
      const now = Date.now();
      const key = `ping:${now}_${Math.random().toString(36).slice(2)}`;
      const data = JSON.stringify({
        name, testUrl, ms, loss, time: new Date().toLocaleString()
      });
      await kv.put(key, data);
      return Response.json({ ok: true });
    }

    // 3. 列出优质记录
    if (url.pathname === "/list") {
      const list = [];
      const res = await kv.list({ prefix: "ping:" });
      for (const item of res.keys) {
        const val = await kv.get(item.name);
        list.push(JSON.parse(val));
      }
      list.sort((a, b) => new Date(b.time) - new Date(a.time));
      return Response.json(list);
    }

    // 其他路径返回网页
    return env.ASSETS.fetch(request);
  }
};
