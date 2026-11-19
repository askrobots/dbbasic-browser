// A tiny extension for the tests: it adds ext.echo and ext.boom.
export function register(api) {
  api.method("echo", async (params, tools) => {
    const wc = await tools.webContents(params);
    return { url: wc.getURL(), said: params.say ?? null };
  });
  api.method("boom", () => {
    throw new Error("boom on purpose");
  });
}
