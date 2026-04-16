import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';

const A4_WIDTH_MM = 210;
const A4_HEIGHT_MM = 297;
const MARGIN_MM = 10;

export async function exportToPdf(
  element: HTMLElement,
  filename = 'dashboard.pdf',
): Promise<void> {
  const canvas = await html2canvas(element, {
    scale: 2,
    useCORS: true,
    logging: false,
    backgroundColor: null,
  });

  const imgWidthMm = A4_WIDTH_MM - MARGIN_MM * 2;
  const imgHeightMm = (canvas.height * imgWidthMm) / canvas.width;
  const pageContentHeight = A4_HEIGHT_MM - MARGIN_MM * 2;

  const pdf = new jsPDF('p', 'mm', 'a4');
  let yOffset = 0;
  let pageNum = 0;

  while (yOffset < imgHeightMm) {
    if (pageNum > 0) pdf.addPage();

    const sliceHeightMm = Math.min(pageContentHeight, imgHeightMm - yOffset);
    const srcY = (yOffset / imgHeightMm) * canvas.height;
    const srcH = (sliceHeightMm / imgHeightMm) * canvas.height;

    const sliceCanvas = document.createElement('canvas');
    sliceCanvas.width = canvas.width;
    sliceCanvas.height = Math.ceil(srcH);
    const ctx = sliceCanvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(canvas, 0, srcY, canvas.width, srcH, 0, 0, canvas.width, Math.ceil(srcH));
    }

    pdf.addImage(
      sliceCanvas.toDataURL('image/png'),
      'PNG',
      MARGIN_MM,
      MARGIN_MM,
      imgWidthMm,
      sliceHeightMm,
    );

    yOffset += pageContentHeight;
    pageNum++;
  }

  pdf.save(filename);
}
