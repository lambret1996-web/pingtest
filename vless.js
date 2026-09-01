export default {
  async fetch(request) {
    const UUID = "62bc5cd2‑5eef‑4e12‑b9b3‑24087eff5082";
    const url = new URL(request.url);

    // 匹配你项目统一的路径前缀 /Proxyip.
    if (!url.pathname.startsWith("/Proxyip.cmliussss.net")) {
      return new Response("Path Not Match", { status: 404 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Require WebSocket Upgrade", { status: 426 });
    }

    const [clientWs, serverWs] = new WebSocketPair();
    serverWs.accept();

    let buffer = new Uint8Array(0);
    let socket = null;

    serverWs.addEventListener("message", async evt => {
      const chunk = new Uint8Array(evt.data);
      const newBuf = new Uint8Array(buffer.length + chunk.length);
      newBuf.set(buffer);
      newBuf.set(chunk, buffer.length);
      buffer = newBuf;

      // VLESS 头部至少17字节才开始解析
      if (buffer.length < 17) return;

      const ver = buffer[0];
      const uuidRaw = buffer.slice(1, 17);
      const targetUuidHex = UUID.replaceAll("-", "");
      const recvUuidHex = Array.from(uuidRaw).map(b => b.toString(16).padStart(2, "0")).join("");

      if (ver !== 0 || recvUuidHex !== targetUuidHex) {
        serverWs.close(1008, "Auth Failed");
        return;
      }

      const cmd = buffer[17];
      const atyp = buffer[18];
      let offset = 19;
      let host, port;

      if (atyp === 1) {
        host = `${buffer[offset]}.${buffer[offset+1]}.${buffer[offset+2]}.${buffer[offset+3]}`;
        offset += 4;
      } else if (atyp === 2) {
        const domainLen = buffer[offset];
        offset++;
        host = new TextDecoder().decode(buffer.slice(offset, offset + domainLen));
        offset += domainLen;
      } else {
        serverWs.close();
        return;
      }

      port = (buffer[offset] << 8) | buffer[offset + 1];
      offset += 2;
      const payload = buffer.slice(offset);
      buffer = new Uint8Array(0);

      // 只处理 TCP 请求
      if (cmd !== 1) {
        serverWs.close();
        return;
      }

      // Cloudflare Worker Socket API
      socket = new Socket({ address: host, port });
      await socket.opened;

      // 收到目标网站数据，转发给客户端WebSocket
      (async () => {
        const reader = socket.readable.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (serverWs.readyState === WebSocket.OPEN) serverWs.send(value);
        }
        serverWs.close();
      })();

      // 首次数据包发送
      if (payload.length > 0) {
        const writer = socket.writable.getWriter();
        await writer.write(payload);
        writer.releaseLock();
      }

      // 后续客户端流量直接转发到出站Socket
      serverWs.addEventListener("message", async e => {
        if (!socket) return;
        const w = socket.writable.getWriter();
        await w.write(new Uint8Array(e.data));
        w.releaseLock();
      });
    });

    serverWs.addEventListener("close", () => {
      if (socket) socket.close();
    });

    return new Response(null, {
      status: 101,
      webSocket: clientWs
    });
  }
};
