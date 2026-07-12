// Proposal PDF generator — mirrors the look of EpoxyCreations' Joist
// estimates (logo header, Prepared For block, scope description, totals,
// signature page). Writes to proposals/ and returns the file path.

import PDFDocument from 'pdfkit';
import { createWriteStream, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RULES = parse(readFileSync(join(ROOT, 'pricing/rules.yaml'), 'utf8'));
const COUNTER = join(ROOT, 'data/estimate-counter.json');

const COMPANY = {
  name: 'Epoxy Creations LLC',
  lines: ['Kissimmee, FL', 'Phone: (321) 328-0030', 'Email: contact@epoxycreationsfl.com', 'Web: www.epoxycreations.net'],
};

export function nextEstimateNumber() {
  // Joist history ends at #418; continue the sequence from 419.
  const state = existsSync(COUNTER) ? JSON.parse(readFileSync(COUNTER, 'utf8')) : { next: 419 };
  const n = state.next;
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(COUNTER, JSON.stringify({ next: n + 1 }));
  return n;
}

const money = n => '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2 });

export function generateProposal(bid, quote, takeoff, estimateNo) {
  mkdirSync(join(ROOT, 'proposals'), { recursive: true });
  const file = join(ROOT, 'proposals', `estimate-${estimateNo}.pdf`);
  const doc = new PDFDocument({ size: 'LETTER', margins: { top: 54, bottom: 54, left: 48, right: 48 } });
  doc.pipe(createWriteStream(file));
  const W = doc.page.width - 96; // content width

  // --- Header ---
  doc.fontSize(22).fillColor('#c9ccd4').font('Helvetica').text('ESTIMATE', 48, 46, { width: W, align: 'center' });
  doc.image(join(ROOT, 'assets/logo.png'), 48, 74, { width: 150 });
  doc.fillColor('#111').fontSize(11).font('Helvetica-Bold').text('Prepared For', 48, 78, { width: W, align: 'right' });
  doc.font('Helvetica').fontSize(10.5);
  const prepared = [bid.client, bid.lead, bid.contactEmail, bid.contactPhone].filter(Boolean);
  let y = 96;
  for (const line of prepared) { doc.text(line, 48, y, { width: W, align: 'right' }); y += 15; }

  y = Math.max(y + 20, 168);
  doc.font('Helvetica-Bold').fontSize(11.5).text(COMPANY.name, 48, y);
  doc.font('Helvetica').fontSize(10.5);
  let yl = y + 18;
  for (const line of COMPANY.lines) { doc.text(line, 48, yl); yl += 15; }
  doc.font('Helvetica').fontSize(10.5);
  doc.text(`Estimate #`, 340, y, { width: 150, align: 'left' });
  doc.text(String(estimateNo), 340, y, { width: W - 292, align: 'right' });
  doc.text('Date', 340, y + 18, { width: 150, align: 'left' });
  doc.text(new Date().toLocaleDateString('en-US'), 340, y + 18, { width: W - 292, align: 'right' });

  y = yl + 24;
  doc.font('Helvetica-Bold').fontSize(11.5).text('Description', 48, y);
  doc.text('Total', 48, y, { width: W, align: 'right' });
  doc.moveTo(48, y + 20).lineTo(48 + W, y + 20).strokeColor('#333').lineWidth(1).stroke();
  y += 32;

  const pageBreak = needed => {
    if (y + needed > doc.page.height - 70) { doc.addPage(); y = 60; }
  };

  // --- One titled section per line item, Joist-style ---
  const sysTpl = RULES.proposal_language?.scope_templates?.[takeoff.system];
  const coveTpl = RULES.proposal_language?.scope_templates?.cove_base;
  let first = true;
  for (const l of quote.lines) {
    const tpl = l.kind === 'system' ? sysTpl : l.kind === 'cove' ? coveTpl : null;
    const title = tpl?.title ?? RULES.prep[l.key]?.label ?? l.label;
    pageBreak(90);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text(title, 48, y, { width: W - 110 });
    doc.text(money(l.amount), 48, y, { width: W, align: 'right' });
    y = doc.y + 8;
    doc.font('Helvetica').fontSize(10.5);
    if (first) {
      doc.text(`${bid.project ?? ''}${bid.location ? ' — ' + bid.location : ''}`, 48, y, { width: W });
      y = doc.y + 10;
    }
    for (const b of tpl?.bullets ?? []) {
      pageBreak(30);
      doc.text(`- ${b}`, 48, y, { width: W });
      y = doc.y + 5;
    }
    y += 4;
    if (l.kind === 'system') {
      doc.text('Estimated Coverage:', 48, y); y = doc.y + 5;
      doc.text(`- Total Project SQFT: ${takeoff.sqft.toLocaleString()}`, 48, y); y = doc.y + 4;
      y += 4;
      doc.fillColor('#333').fontSize(9.5)
        .text(`Note: ${RULES.proposal_language.site_measure_note.trim().replace(/\s+/g, ' ')} This estimate is valid for ${quote.validityDays} days.`, 48, y, { width: W });
      y = doc.y + 6;
      doc.fillColor('#111').fontSize(10.5);
    }
    if (l.kind === 'cove') {
      doc.text(`- Total linear feet: ${takeoff.coveLf.toLocaleString()}`, 48, y); y = doc.y + 4;
    }
    y += 6;
    if (first) first = false;
    doc.moveTo(48, y).lineTo(48 + W, y).strokeColor('#dcdfe5').lineWidth(0.7).stroke();
    y += 12;
  }

  // --- Subtotal / Total, right-aligned like the Joist estimates ---
  pageBreak(80);
  const sub = quote.lines.reduce((s, l) => s + l.amount, 0);
  doc.font('Helvetica-Bold').fontSize(11).text('Subtotal', 340, y);
  doc.font('Helvetica').text(money(sub), 340, y, { width: W - 292, align: 'right' });
  y = doc.y + 8;
  if (quote.floored) {
    doc.fillColor('#555').fontSize(9.5).text(`Adjusted to job minimum (${money(RULES.job_rules.minimum_contract)})`, 340, y, { width: W - 292 });
    y = doc.y + 6;
    doc.fillColor('#111');
  }
  doc.moveTo(340, y).lineTo(48 + W, y).strokeColor('#333').lineWidth(1).stroke();
  y += 8;
  doc.font('Helvetica-Bold').fontSize(11.5).text('Total', 340, y);
  doc.text(money(quote.total), 340, y, { width: W - 292, align: 'right' });
  y = doc.y + 10;
  if (bid.proposalExclusions) {
    pageBreak(60);
    doc.font('Helvetica').fontSize(9.5).fillColor('#333');
    for (const n of [].concat(bid.proposalExclusions)) {
      doc.text(`- ${n.replace(/\s+/g, ' ')}`, 48, y, { width: W });
      y = doc.y + 4;
    }
  }

  // --- Signature page ---
  doc.addPage();
  doc.font('Helvetica').fontSize(10.5).fillColor('#111')
    .text('By signing this document, the customer agrees to the services and conditions outlined in this document.', 48, 64, { width: W });
  doc.moveTo(48, 200).lineTo(48 + 200, 200).strokeColor('#333').lineWidth(1).stroke();
  doc.text('EPOXY CREATIONS LLC', 48, 210, { width: 200, align: 'center' });
  doc.moveTo(48 + W - 200, 200).lineTo(48 + W, 200).stroke();
  doc.text(bid.client ?? '', 48 + W - 200, 210, { width: 200, align: 'center' });

  doc.end();
  return file;
}
