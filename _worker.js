export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/list") {
      return new Response("✅ 接口已生效", {
        headers: { "Content-Type": "text/plain;charset=utf-8" }
      });
    }
    return env.ASSETS.fetch(request);
  }
};
