"use client";

import { useEffect, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FileDown, Loader2, FileText, RotateCcw, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { CostBadge } from "@/components/cost/cost-badge";
import { CvPdfFileActions } from "@/components/cv-pdf-file-actions";
import { pdfButtonState, pdfJobRefreshesReport, type PdfFailure } from "@/lib/pdf-button-state.mjs";
import { isWordCvView } from "@/lib/cv-format.mjs";
import { pipelineQuery } from "@/lib/pipeline-navigation.mjs";

const quietPill =
  "inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand-text max-sm:min-h-[44px]";

// Fires the real career-ops `pdf` or `docx` mode to generate an
// ATS-optimized CV tailored to THIS offer → output/cv-… + marks the tracker.
export function GeneratePdfButton({
  n,
  company,
  onDisk,
  outputFormat = "pdf",
  cvIsWord = false,
}: {
  n: string;
  company: string;
  onDisk: boolean;
  outputFormat?: "pdf" | "docx";
  cvIsWord?: boolean;
}) {
  const { jobs, startJob } = useJobs();
  const router = useRouter();
  const listQuery = pipelineQuery(useSearchParams().toString());
  useEffect(() => {
    const onDone = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      if (pdfJobRefreshesReport(detail, n)) router.refresh();
    };
    window.addEventListener("co-job-done", onDone);
    return () => window.removeEventListener("co-job-done", onDone);
  }, [n, router]);
  const jobQuery = listQuery ? `?${listQuery}` : "";
  const studioHref = `/pipeline/${encodeURIComponent(n)}/cv-studio${jobQuery}`;
  const kind = outputFormat === "docx" ? "docx" : "pdf";
  const fileHref = `/api/cv-pdf?n=${encodeURIComponent(n)}&company=${encodeURIComponent(company)}`;
  const job = useMemo(
    () => jobs.filter((j) => (j.kind === "pdf" || j.kind === "docx") && j.input === n).sort((a, b) => b.startedAt - a.startedAt)[0],
    [jobs, n],
  );
  const generate = () =>
    startJob({
      title: `CV · ${company}`,
      subtitle: kind === "docx" ? "Word" : "PDF",
      kind,
      input: n,
      page: `/pipeline/${n}`,
    });
  const wordView = isWordCvView(cvIsWord, job?.kind);
  const viewHref = wordView
    ? `/api/cv-preview?n=${encodeURIComponent(n)}&company=${encodeURIComponent(company)}`
    : `/api/cv-pdf?n=${encodeURIComponent(n)}&company=${encodeURIComponent(company)}`;

  const state = pdfButtonState(job, onDisk);

  if (state.kind === "running")
    return (
      <Link href={`/jobs/${state.jobId}${jobQuery}`} className="inline-flex items-center justify-center gap-1.5 rounded-full border border-brand/40 bg-brand-soft px-3 py-1 text-xs font-medium text-brand-text max-sm:min-h-[44px]">
        <Loader2 className="size-3.5 animate-spin" /> Generating CV…
      </Link>
    );

  if (state.kind === "ready")
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <a
          href={viewHref}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center justify-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-800 transition-colors hover:bg-emerald-500/15 dark:text-emerald-400 max-sm:min-h-[44px]"
        >
          <FileText className="size-3.5" /> View tailored CV
        </a>
        <CvPdfFileActions viewHref={fileHref} className={quietPill} />
        {!wordView && (
          <Link
            href={studioHref}
            className="inline-flex items-center justify-center gap-1.5 rounded-full border border-brand/40 bg-brand-soft px-3 py-1 text-xs font-medium text-brand-text transition-colors hover:bg-brand-soft/70 max-sm:min-h-[44px]"
          >
            <SlidersHorizontal className="size-3.5" /> Review and customize
          </Link>
        )}
        <button
          onClick={generate}
          title="Regenerate the tailored CV"
          className="inline-flex items-center justify-center rounded-full p-1 text-faint transition-colors hover:text-brand-text max-sm:min-h-[44px] max-sm:min-w-[44px]"
        >
          <RotateCcw className="size-3" />
        </button>
        <FailureNote failure={state.failure} jobQuery={jobQuery} />
      </span>
    );

  // Point-of-action cost affordance: generating a tailored CV runs the user's
  // AI (spends tokens). Surface it right on the trigger so cost is never a
  // surprise — the community's #1 pain (mirrors Explore's token-honesty).
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <button
        onClick={generate}
        className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand-text max-sm:min-h-[44px]"
        title="Generate an ATS-optimized CV tailored to this role"
      >
        <FileDown className="size-3.5" /> Generate tailored CV ({kind === "docx" ? "Word" : "PDF"})
      </button>
      <CostBadge kind="spend" size="xs" />
      <FailureNote failure={state.failure} jobQuery={jobQuery} />
    </span>
  );
}

function FailureNote({ failure, jobQuery }: { failure: PdfFailure; jobQuery: string }) {
  if (!failure) return null;
  return (
    <Link
      href={`/jobs/${failure.jobId}${jobQuery}`}
      role="alert"
      title="Open the run log"
      className="inline-flex max-w-md items-start gap-1 text-xs text-red-700 hover:underline dark:text-red-400"
    >
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
      <span>CV not generated. {failure.reason}</span>
    </Link>
  );
}
