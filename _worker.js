新增功能说明

在原有逻辑基础上，自动记录每个访客IP的详细信息，包含：IP地址、首次访问时间、最后访问时间、累计访问次数；同时新增 /ip-list 接口可查看所有访客记录，30天无访问的IP会自动过期清理，不占用KV空间。原有访问统计、测速保存功能完全不变。

完整替换 _worker.js 代码
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const kv = env.KV;

    // 1. 访问统计接口 + IP记录
    if (url.pathname === "/visit") {
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const today = new Date().toISOString().slice(0, 10);
      const totalKey = "visit:total_visit";
      const dayKey = `visit:day:${today}`;
      const ipKey = `visit:ip:${ip}`;

      // 总访问量+1
      let total = Number(await kv.get(totalKey)) || 0;
      total += 1;
      await kv.put(totalKey, String(total));

      // 今日访问量+1
      let dayCnt = Number(await kv.get(dayKey)) || 0;
      dayCnt += 1;
      await kv.put(dayKey, String(dayCnt));

      // 记录访客IP详情
      const ipRecordStr = await kv.get(ipKey);
      let ipRecord;
      if (ipRecordStr) {
        ipRecord = JSON.parse(ipRecordStr);
        ipRecord.lastTime = new Date().toLocaleString();
        ipRecord.count += 1;
      } else {
        ipRecord = {
          ip: ip,
          firstTime: new Date().toLocaleString(),
          lastTime: new Date().toLocaleString(),
          count: 1
        };
      }
      await kv.put(ipKey, JSON.stringify(ipRecord), { expirationTtl: 86400 * 30 });

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

    // 3. 列出优质测速记录
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

    // 4. 列出所有访客IP记录
    if (url.pathname === "/ip-list") {
      const list = [];
      const res = await kv.list({ prefix: "visit:ip:" });
      for (const item of res.keys) {
        const val = await kv.get(item.name);
        list.push(JSON.parse(val));
      }
      // 按最后访问时间倒序排列
      list.sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime));
      return Response.json(list);
    }

    // 其他路径返回网页
    return env.ASSETS.fetch(request);
  }
};
验证方法

部署完成后：

1. 刷新你的测速主页 1-2 次

2. 浏览器访问 https://testing.pages.dev/ip-list

3. 能看到你的IP、首次/最后访问时间、访问次数，就说明功能正常

可选调整

• 过期时间：代码里 expirationTtl: 86400 * 30 是30天，可自行修改天数

• 如果需要记录每次访问的独立日志（而不是去重统计），可以告诉我改成逐条存储的版本

这是网页功能新增需求，工作任务模式可以帮你把IP记录做成可视化页面、加筛选和分页，要不要切过去？
