import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)

async function measureRemoteImageFetches(allowRemoteImages?: boolean): Promise<number> {
  const options = allowRemoteImages === undefined ? "" : `, { allowRemoteImages: ${allowRemoteImages} }`
  const source = `
    import { htmlToDocxBlob } from "@platejs/docx-io";
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error("阻止测试网络请求");
    };
    await htmlToDocxBlob(
      '<p>正文</p><img src="https://example.invalid/private.png">'
      ${options}
    );
    console.log(calls);
  `
  const { stdout } = await execFileAsync("bun", ["-e", source], {
    cwd: process.cwd(),
    encoding: "utf8",
  })
  return Number(stdout.trim())
}

describe("DOCX 导出远程图片安全边界", () => {
  it("默认不抓取正文中的远程图片", async () => {
    expect(await measureRemoteImageFetches()).toBe(0)
  })

  it("仅在可信调用方显式启用时抓取远程图片", async () => {
    expect(await measureRemoteImageFetches(true)).toBe(1)
  })
})
