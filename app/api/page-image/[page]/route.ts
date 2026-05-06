import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { join } from "path";

/**
 * GET /api/page-image/:page
 *
 * If PAGE_IMAGES_BASE_URL is set in env (prod / Vercel), redirect to
 * `${PAGE_IMAGES_BASE_URL}/p{NNN}.png` — typically a Vercel Blob /
 * Cloudflare R2 / S3 URL.
 *
 * Otherwise (local dev), read the file from public/pages/p{NNN}.png and
 * stream it back. Browsers can also reach public/pages/p{NNN}.png
 * directly without going through this route, but this indirection lets
 * the same client code work in both setups.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { page: string } }
) {
  const page = Number.parseInt(params.page, 10);
  if (!Number.isFinite(page)) {
    return NextResponse.json({ error: "bad page" }, { status: 400 });
  }
  const filename = `p${page.toString().padStart(3, "0")}.png`;

  const baseUrl = process.env.PAGE_IMAGES_BASE_URL;
  if (baseUrl) {
    return NextResponse.redirect(`${baseUrl}/${filename}`, 302);
  }

  try {
    const path = join(process.cwd(), "public", "pages", filename);
    const data = await readFile(path);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json(
      { error: `image not found: ${filename}` },
      { status: 404 }
    );
  }
}
