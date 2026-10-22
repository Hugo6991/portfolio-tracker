import type { ExpenseInputMethod } from "@/lib/expense-records";

export type ReceiptReadProgress = {
  stage: "loading" | "reading" | "recognizing" | "complete";
  label: string;
  progress: number;
};

export type ReceiptReadResult = {
  text: string;
  inputMethod: ExpenseInputMethod;
};

const maxFileBytes = 12 * 1024 * 1024;

export async function readReceiptFile(
  file: File,
  onProgress: (progress: ReceiptReadProgress) => void
): Promise<ReceiptReadResult> {
  if (file.size > maxFileBytes) throw new Error("Choose a file smaller than 12 MB");

  const extension = file.name.split(".").pop()?.toLowerCase();
  const isText = file.type.startsWith("text/") || extension === "csv" || extension === "txt";
  const isPdf = file.type === "application/pdf" || extension === "pdf";
  const isImage = file.type.startsWith("image/") || ["jpg", "jpeg", "png", "webp", "bmp"].includes(extension || "");

  if (isText) {
    onProgress({ stage: "reading", label: "Reading document", progress: 0.45 });
    const text = await file.text();
    onProgress({ stage: "complete", label: "Ready to review", progress: 1 });
    return { text, inputMethod: extension === "csv" ? "csv" : "text" };
  }

  if (isPdf) return readPdf(file, onProgress);
  if (isImage) {
    const text = await recognizeImage(file, onProgress, 0, 1);
    onProgress({ stage: "complete", label: "Ready to review", progress: 1 });
    return { text, inputMethod: "image-ocr" };
  }

  throw new Error("Use a JPG, PNG, WebP, PDF, CSV, or TXT file");
}

async function readPdf(file: File, onProgress: (progress: ReceiptReadProgress) => void): Promise<ReceiptReadResult> {
  onProgress({ stage: "loading", label: "Opening PDF", progress: 0.08 });
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/legacy/build/pdf.worker.min.mjs`;
  const document = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pageCount = Math.min(document.numPages, 3);
  const pageTexts: string[] = [];

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    onProgress({
      stage: "reading",
      label: `Reading PDF page ${pageNumber} of ${pageCount}`,
      progress: 0.1 + (pageNumber / pageCount) * 0.35
    });
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .trim();
    if (text) pageTexts.push(text);
  }

  const embeddedText = pageTexts.join("\n");
  if (embeddedText.length >= 40) {
    onProgress({ stage: "complete", label: "Ready to review", progress: 1 });
    return { text: embeddedText, inputMethod: "pdf-text" };
  }

  const ocrTexts: string[] = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.6 });
    const canvas = window.document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("This browser could not prepare the PDF for reading");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: context, viewport }).promise;
    const start = 0.4 + ((pageNumber - 1) / pageCount) * 0.55;
    const end = 0.4 + (pageNumber / pageCount) * 0.55;
    ocrTexts.push(await recognizeImage(canvas, onProgress, start, end));
  }

  onProgress({ stage: "complete", label: "Ready to review", progress: 1 });
  return { text: ocrTexts.join("\n"), inputMethod: "pdf-ocr" };
}

async function recognizeImage(
  image: File | HTMLCanvasElement,
  onProgress: (progress: ReceiptReadProgress) => void,
  start: number,
  end: number
) {
  onProgress({ stage: "loading", label: "Loading on-device reader", progress: Math.max(start, 0.04) });
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker(["eng", "chi_tra"], undefined, {
    logger(message) {
      if (message.status !== "recognizing text") return;
      const progress = start + (end - start) * Math.max(0, Math.min(1, message.progress));
      onProgress({ stage: "recognizing", label: "Reading receipt text", progress });
    }
  });

  try {
    const result = await worker.recognize(image, { rotateAuto: true });
    return result.data.text.trim();
  } finally {
    await worker.terminate();
  }
}
