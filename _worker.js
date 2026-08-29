export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const kv = env.KV;

    // 1. 访问统计 + IP记录
    if (url.pathname === "/visit") {
      try {
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

        // 记录访客IP详情 - 兼容旧格式数据
        const ipRecordStr = await kv.get(ipKey);
        let ipRecord;
        try {
          ipRecord = JSON.parse(ipRecordStr);
          // 校验是否为合法的记录对象
          if (!ipRecord || typeof ipRecord !== 'object' || !ipRecord.count) {
            throw new Error('格式不匹配');
          }
          ipRecord.lastTime = new Date().toLocaleString();
          ipRecord.count += 1;
        } catch (e) {
          // 旧数据或格式错误，重置为新记录
          ipRecord = {
            ip: ip,
            firstTime: new Date().toLocaleString(),
            lastTime: new Date().toLocaleString(),
            count: 1
          };
        }
        await kv.put(ipKey, JSON.stringify(ipRecord), { expirationTtl: 86400 * 30 });

        return Response.json({ total, today: dayCnt });
      } catch (e) {
        // 异常兜底，保证接口有返回
        return Response.json({ total: 0, today: 0, error: e.message }, { status: 500 });
      }
    }

    // 2. 保存优质测速记录
    if (url.pathname === "/save") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      try {
        const body = await request.json();
        const { name, testUrl, ms, loss } = body;
        const now = Date.now();
        const key = `ping:${now}_${Math.random().toString(36).slice(2)}`;
        const data = JSON.stringify({
          name, testUrl, ms, loss, time: new Date().toLocaleString()
        });
        await kv.put(key, data);
        return Response.json({ ok: true });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    }

    // 3. 列出优质测速记录
    if (url.pathname === "/list") {
      try {
        const list = [];
        const res = await kv.list({ prefix: "ping:" });
        for (const item of res.keys) {
          const val = await kv.get(item.name);
          list.push(JSON.parse(val));
        }
        list.sort((a, b) => new Date(b.time) - new Date(a.time));
        return Response.json(list);
      } catch (e) {
        return Response.json([]);
      }
    }

    // 4. 列出所有访客IP记录
    if (url.pathname === "/ip-list") {
      try {
        const list = [];
        const res = await kv.list({ prefix: "visit:ip:" });
        for (const item of res.keys) {
          const val = await kv.get(item.name);
          try {
            list.push(JSON.parse(val));
          } catch (e) {
            // 跳过格式错误的历史数据
            continue;
          }
        }
        list.sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime));
        return Response.json(list);
      } catch (e) {
        return Response.json([]);
      }
    }

    // 其他路径返回网页
    return env.ASSETS.fetch(request);
  }
};
