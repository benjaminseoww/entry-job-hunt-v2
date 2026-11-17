import { careerOpsRoot } from "@/lib/career-ops";
import { readCvOutputFormat } from "@/lib/cv-output-format.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** cv.output_format from the profile — what Generate will produce. */
export async function GET() {
  return Response.json(
    { format: readCvOutputFormat(careerOpsRoot()) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
