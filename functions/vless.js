// Cloudflare Pages Functions - VLESS over WebSocket
// Production-optimized version with error handling, validation, and logging

// UUID 配置（与表单联动）
const UUID = '5759d2b4-11d5-461c-91a5-e493f3dbb2c5';
const VLESS_VERSION = 0;

// 错误类型定义
class VlessError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'VlessError';
    this.code = code;
  }
}

export async function onRequest(context) {
  const { request } = context;

  try {
    // 验证 WebSocket 升级请求
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader?.toLowerCase() !== 'websocket') {
      return new Response('Upgrade header must be websocket', { status: 400 });
    }

    // 创建 WebSocket 对
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // 接受连接并处理
    server.accept();
    handleConnection(server, context);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  } catch (error) {
    console.error('[VLESS] 初始化错误:', error.message);
    return new Response('Internal Server Error', { status: 500 });
  }
}

/**
 * 处理 WebSocket 连接
 */
async function handleConnection(ws, context) {
  let connectionInfo = {
    address: 'unknown',
    port: 0,
    startTime: Date.now(),
    bytesReceived: 0,
    bytesSent: 0,
  };

  const log = (level, message, data = '') => {
    const duration = Date.now() - connectionInfo.startTime;
    const logLine = `[${level}] [${connectionInfo.address}:${connectionInfo.port}] [${duration}ms] ${message}${data ? ' - ' + JSON.stringify(data) : ''}`;
    console.log(logLine);
  };

  let remoteSocket = null;
  let vlessHeader = null;
  let isFirst = true;

  ws.addEventListener('message', async (event) => {
    try {
      const buffer = new Uint8Array(event.data);
      connectionInfo.bytesReceived += buffer.length;

      if (isFirst) {
        isFirst = false;

        // 解析和验证 VLESS 头
        try {
          vlessHeader = parseVlessHeader(buffer);
        } catch (e) {
          log('ERROR', '头部解析失败', e.message);
          ws.close(1002, 'Invalid VLESS header');
          return;
        }

        // UUID 验证
        const normalizedUUID = UUID.replace(/-/g, '');
        if (vlessHeader.uuid !== normalizedUUID) {
          log('ERROR', 'UUID 验证失败', `期望: ${normalizedUUID}, 收到: ${vlessHeader.uuid}`);
          ws.close(1008, 'Invalid UUID');
          return;
        }

        connectionInfo.address = vlessHeader.address;
        connectionInfo.port = vlessHeader.port;

        log('INFO', '开始连接远程服务器');

        // 创建远程连接
        try {
          remoteSocket = new Connect();
          await remoteSocket.connect({
            hostname: vlessHeader.address,
            port: vlessHeader.port,
          });
          log('INFO', '远程服务器已连接');
        } catch (e) {
          log('ERROR', '无法连接远程服务器', e.message);
          ws.close(1011, 'Failed to connect remote server');
          return;
        }

        // 管道化远程响应到 WebSocket
        try {
          remoteSocket.readable.pipeTo(
            new WritableStream({
              write(chunk) {
                connectionInfo.bytesSent += chunk.length;

                // 第一个响应包含 VLESS 响应头
                if (vlessHeader.responseHeader) {
                  const responseData = new Uint8Array(
                    vlessHeader.responseHeader.length + chunk.length
                  );
                  responseData.set(vlessHeader.responseHeader, 0);
                  responseData.set(chunk, vlessHeader.responseHeader.length);
                  ws.send(responseData);
                  vlessHeader.responseHeader = null;
                } else {
                  ws.send(chunk);
                }
              },
              close() {
                log('INFO', '远程连接已关闭');
                ws.close(1000);
              },
              abort(reason) {
                log('WARN', '远程连接中止', reason?.message || '未知原因');
                ws.close(1011);
              },
            })
          );
        } catch (e) {
          log('ERROR', '管道化错误', e.message);
          ws.close(1011);
          return;
        }

        // 发送 VLESS 头之后的数据
        if (buffer.length > vlessHeader.headerLength) {
          const remainingData = buffer.slice(vlessHeader.headerLength);
          try {
            await remoteSocket.write(remainingData);
          } catch (e) {
            log('ERROR', '初始数据写入失败', e.message);
            ws.close(1011);
          }
        }
      } else {
        // 后续消息直接转发
        if (!remoteSocket) {
          log('ERROR', '远程套接字不存在');
          ws.close(1011);
          return;
        }

        try {
          await remoteSocket.write(buffer);
        } catch (e) {
          log('ERROR', '数据转发失败', e.message);
          ws.close(1011);
        }
      }
    } catch (e) {
      log('ERROR', 'WebSocket 消息处理错误', e.message);
      ws.close(1011);
    }
  });

  ws.addEventListener('close', () => {
    log('INFO', `连接已关闭 (↓${connectionInfo.bytesReceived}B ↑${connectionInfo.bytesSent}B)`);
    if (remoteSocket) {
      remoteSocket.close();
    }
  });

  ws.addEventListener('error', (e) => {
    log('ERROR', 'WebSocket 错误', e.message);
    if (remoteSocket) {
      remoteSocket.close();
    }
  });
}

/**
 * 解析 VLESS 协议头
 * 格式: [版本(1B)][UUID(16B)][加密方式长度(1B)][加密方式][端口(2B)][地址类型(1B)][地址][?长度(1B)][?数据]
 */
function parseVlessHeader(buffer) {
  // 最小长度检查：1(版本) + 16(UUID) + 1(加密方式长度) + 2(端口) + 1(地址类型) = 21
  if (buffer.length < 21) {
    throw new VlessError('缓冲区过短，无效的 VLESS 头', 'BUFFER_TOO_SHORT');
  }

  let offset = 0;

  // 读取版本
  const version = buffer[offset++];
  if (version !== VLESS_VERSION) {
    throw new VlessError(`不支持的 VLESS 版本: ${version}`, 'UNSUPPORTED_VERSION');
  }

  // 读取 UUID (16字节)
  if (offset + 16 > buffer.length) {
    throw new VlessError('缓冲区过短，无法读取 UUID', 'BUFFER_TOO_SHORT');
  }
  const uuidBytes = buffer.slice(offset, offset + 16);
  offset += 16;
  const uuid = Array.from(uuidBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // 读取加密方式长度
  if (offset >= buffer.length) {
    throw new VlessError('缓冲区过短，无法读取加密方式长度', 'BUFFER_TOO_SHORT');
  }
  const cipherLen = buffer[offset++];
  if (cipherLen > 16) {
    throw new VlessError(`加密方式长度过长: ${cipherLen}`, 'INVALID_CIPHER_LEN');
  }

  // 跳过加密方式数据
  if (offset + cipherLen > buffer.length) {
    throw new VlessError('缓冲区过短，无法读取加密方式', 'BUFFER_TOO_SHORT');
  }
  offset += cipherLen;

  // 读取端口 (大端序，2字节)
  if (offset + 2 > buffer.length) {
    throw new VlessError('缓冲区过短，无法读取端口', 'BUFFER_TOO_SHORT');
  }
  const port = (buffer[offset] << 8) | buffer[offset + 1];
  offset += 2;

  if (port < 1 || port > 65535) {
    throw new VlessError(`端口号无效: ${port}`, 'INVALID_PORT');
  }

  // 读取地址类型
  if (offset >= buffer.length) {
    throw new VlessError('缓冲区过短，无法读取地址类型', 'BUFFER_TOO_SHORT');
  }
  const addrType = buffer[offset++];

  let address = '';
  let headerLength = 0;

  // 根据地址类型解析地址
  if (addrType === 1) {
    // IPv4 (4字节)
    if (offset + 4 > buffer.length) {
      throw new VlessError('缓冲区过短，无法读取 IPv4 地址', 'BUFFER_TOO_SHORT');
    }
    address = Array.from(buffer.slice(offset, offset + 4)).join('.');
    offset += 4;
    headerLength = offset;
  } else if (addrType === 2) {
    // 域名 (1字节长度 + 域名数据)
    if (offset >= buffer.length) {
      throw new VlessError('缓冲区过短，无法读取域名长度', 'BUFFER_TOO_SHORT');
    }
    const domainLen = buffer[offset++];

    if (domainLen === 0 || domainLen > 255) {
      throw new VlessError(`域名长度无效: ${domainLen}`, 'INVALID_DOMAIN_LEN');
    }

    if (offset + domainLen > buffer.length) {
      throw new VlessError('缓冲区过短，无法读取域名', 'BUFFER_TOO_SHORT');
    }

    address = new TextDecoder().decode(buffer.slice(offset, offset + domainLen));
    offset += domainLen;
    headerLength = offset;
  } else if (addrType === 3) {
    // IPv6 (16字节)
    if (offset + 16 > buffer.length) {
      throw new VlessError('缓冲区过短，无法读取 IPv6 地址', 'BUFFER_TOO_SHORT');
    }
    const ipv6Parts = [];
    for (let i = 0; i < 16; i += 2) {
      ipv6Parts.push(
        buffer[offset + i].toString(16).padStart(2, '0') +
          buffer[offset + i + 1].toString(16).padStart(2, '0')
      );
    }
    address = ipv6Parts.join(':');
    offset += 16;
    headerLength = offset;
  } else {
    throw new VlessError(`不支持的地址类型: ${addrType}`, 'UNSUPPORTED_ADDR_TYPE');
  }

  // 验证地址
  if (!address || address.length === 0) {
    throw new VlessError('地址为空', 'EMPTY_ADDRESS');
  }

  // 构建响应头：[版本(1B)][命令(1B)]
  const responseHeader = new Uint8Array([version, 0]);

  return {
    uuid,
    address,
    port,
    headerLength,
    responseHeader,
  };
}

/**
 * Connect 类：管理远程 TCP 连接
 */
class Connect {
  constructor() {
    this.writable = null;
    this.readable = null;
    this.socket = null;
  }

  /**
   * 连接到远程服务器
   */
  async connect(options) {
    try {
      this.socket = new Socket(options);

      // 等待连接打开
      if (this.socket.opened) {
        await this.socket.opened;
      }

      this.readable = this.socket.readable;
      this.writable = this.socket.writable;

      // 监听关闭事件
      if (this.socket.closed) {
        this.socket.closed.catch(() => {
          // 连接已关闭
        });
      }
    } catch (error) {
      throw new VlessError(`连接失败: ${error.message}`, 'CONNECT_FAILED');
    }
  }

  /**
   * 写入数据到远程服务器
   */
  async write(data) {
    if (!this.writable) {
      throw new VlessError('可写流不可用', 'WRITABLE_UNAVAILABLE');
    }

    try {
      const writer = this.writable.getWriter();
      try {
        await writer.write(data);
      } finally {
        writer.releaseLock();
      }
    } catch (error) {
      throw new VlessError(`写入失败: ${error.message}`, 'WRITE_FAILED');
    }
  }

  /**
   * 关闭连接
   */
  close() {
    if (this.socket) {
      try {
        this.socket.close();
      } catch (e) {
        // 关闭时出错，忽略
      }
    }
  }
}
