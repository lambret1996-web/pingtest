// Cloudflare Pages Functions - VLESS over WebSocket
// UUID 占位符：1a407d28-4629-4c8b-9363-c33698d41872（与表单联动）

const UUID = '1a407d28-4629-4c8b-9363-c33698d41872';

export async function onRequest(context) {
  const { request } = context;
  const upgradeHeader = request.headers.get('Upgrade');

  if (upgradeHeader !== 'websocket') {
    return new Response('Not Found', { status: 404 });
  }

  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);

  server.accept();
  handleConnection(server, context);

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

async function handleConnection(ws, context) {
  let address = '';
  let portWithRandomLog = '';
  const log = (info, event) => {
    console.log(`[${address}:${portWithRandomLog}]`, info, event || '');
  };

  const remoteSocket = new Connect();
  let vlessHeader = null;
  let isFirst = true;

  ws.addEventListener('message', async (event) => {
    try {
      const buffer = new Uint8Array(event.data);

      if (isFirst) {
        isFirst = false;
        vlessHeader = parseVlessHeader(buffer);
        
        if (vlessHeader.uuid !== UUID.replace(/-/g, '')) {
          ws.close();
          return;
        }

        address = vlessHeader.address;
        const port = vlessHeader.port;
        portWithRandomLog = port + ' - ' + Math.random().toString(36).substring(2, 6);
        
        log('connecting');
        
        await remoteSocket.connect({
          hostname: address,
          port: port,
        });
        
        log('connected');

        remoteSocket.readable.pipeTo(
          new WritableStream({
            write(chunk) {
              if (vlessHeader && vlessHeader.responseHeader) {
                const data = new Uint8Array(vlessHeader.responseHeader.length + chunk.length);
                data.set(vlessHeader.responseHeader, 0);
                data.set(chunk, vlessHeader.responseHeader.length);
                ws.send(data);
                vlessHeader.responseHeader = null;
              } else {
                ws.send(chunk);
              }
            },
            close() {
              log('remote closed');
              ws.close();
            },
            abort(reason) {
              log('remote abort', reason);
              ws.close();
            },
          })
        );

        if (buffer.length > vlessHeader.headerLength) {
          const data = buffer.slice(vlessHeader.headerLength);
          await remoteSocket.write(data);
        }
      } else {
        await remoteSocket.write(buffer);
      }
    } catch (e) {
      log('ws message error', e.message);
      ws.close();
    }
  });

  ws.addEventListener('close', () => {
    log('ws closed');
    remoteSocket.close();
  });

  ws.addEventListener('error', (e) => {
    log('ws error', e.message);
    remoteSocket.close();
  });
}

function parseVlessHeader(buffer) {
  const version = buffer[0];
  const uuidBytes = buffer.slice(1, 17);
  const uuid = [...uuidBytes].map(b => b.toString(16).padStart(2, '0')).join('');
  const addLen = buffer[17];
  let portIndex = 18 + addLen;
  const port = (buffer[portIndex] << 8) | buffer[portIndex + 1];
  const addrType = buffer[portIndex + 2];
  let addr;
  let dataIndex;

  if (addrType === 1) {
    addr = buffer.slice(portIndex + 3, portIndex + 7).join('.');
    dataIndex = portIndex + 7;
  } else if (addrType === 2) {
    const len = buffer[portIndex + 3];
    addr = new TextDecoder().decode(buffer.slice(portIndex + 4, portIndex + 4 + len));
    dataIndex = portIndex + 4 + len;
  } else {
    addr = [...buffer.slice(portIndex + 3, portIndex + 19)].map(b => b.toString(16).padStart(2, '0')).join(':');
    dataIndex = portIndex + 19;
  }

  const headerLength = dataIndex;
  const responseHeader = new Uint8Array([version, 0]);

  return { uuid, address: addr, port, headerLength, responseHeader };
}

class Connect {
  constructor() {
    this.writable = null;
    this.readable = null;
    this.socket = null;
  }

  async connect(options) {
    this.socket = new Socket(options);
    this.readable = this.socket.readable;
    this.writable = this.socket.writable;
    
    if (this.socket.opened) {
      await this.socket.opened;
    }
    if (this.socket.closed) {
      this.socket.closed.catch(() => {});
    }
  }

  async write(data) {
    if (!this.writable) return;
    const writer = this.writable.getWriter();
    await writer.write(data);
    writer.releaseLock();
  }

  close() {
    if (this.socket) {
      try {
        this.socket.close();
      } catch (e) {}
    }
  }
}
