import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import bwipjs from 'bwip-js';

/**
 * The shipping label (spec §5.5). 4×6 inches, black on white.
 *
 * The contents list is EXHAUSTIVE: service band, recipient, address, phone,
 * note, origin store name, box-reference barcode, and the seal / ticket /
 * signature-required chips.
 *
 * The label MUST NOT carry product names, SKUs, IMEIs, quantities, declared
 * value, any currency symbol, or provider branding. A box labelled
 * "iPhone 16 Pro" is an advertisement to whoever walks past it. The leak test
 * in test/label.test.ts enforces this — keep it, because this is exactly the
 * rule someone reverses in six months when "the driver wants to know what's
 * inside."
 */

export interface LabelData {
  movement_ref: string;
  service_name: string;
  service_window: string;
  recipient_name: string;
  recipient_locale: 'fr-CA' | 'en-CA';
  recipient_phone: string | null;
  address: { unit?: string | null; line1: string; city: string; province: string; postal: string;
             note?: string | null };
  from_store: string;
  box_ref: string;
  seal_no: string;
  seal_count: number;
  copy_number: number;
}

const PT_PER_IN = 72;
const W = 4 * PT_PER_IN;
const H = 6 * PT_PER_IN;
const M = 16;

const BLACK = rgb(0, 0, 0);
const WHITE = rgb(1, 1, 1);

export async function renderLabel(d: LabelData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([W, H]);
  const sans = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);

  let y = H - M;

  // header: seal mark + wordmark + movement ref
  page.drawRectangle({ x: M, y: y - 12, width: 12, height: 12, color: BLACK });
  page.drawRectangle({ x: M + 15, y: y - 11, width: 10, height: 10,
    borderColor: BLACK, borderWidth: 1.4 });
  page.drawText('CUSTODE', { x: M + 33, y: y - 10, size: 10, font: bold });
  const refW = mono.widthOfTextAtSize(d.movement_ref, 9);
  page.drawText(d.movement_ref, { x: W - M - refW, y: y - 10, size: 9, font: mono });
  y -= 22;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1.6, color: BLACK });
  y -= 8;

  // service band — white on black
  page.drawRectangle({ x: M, y: y - 24, width: W - 2 * M, height: 24, color: BLACK });
  page.drawText(d.service_name.toUpperCase(), { x: M + 8, y: y - 17, size: 11, font: bold, color: WHITE });
  const winTxt = d.service_window.toUpperCase();
  const winW = bold.widthOfTextAtSize(winTxt, 11);
  page.drawText(winTxt, { x: W - M - 8 - winW, y: y - 17, size: 11, font: bold, color: WHITE });
  y -= 38;

  // deliver to
  const cap = (t: string) => {
    page.drawText(t, { x: M, y, size: 6.5, font: bold, color: BLACK });
    y -= 12;
  };
  cap(d.recipient_locale === 'fr-CA' ? 'LIVRER À' : 'DELIVER TO');

  page.drawText(d.recipient_name, { x: M, y, size: 14, font: bold });
  const chip = d.recipient_locale === 'fr-CA' ? 'FR' : 'EN';
  const nameW = bold.widthOfTextAtSize(d.recipient_name, 14);
  page.drawRectangle({ x: M + nameW + 8, y: y - 2, width: 20, height: 13,
    borderColor: BLACK, borderWidth: 1.2 });
  page.drawText(chip, { x: M + nameW + 12.5, y: y + 1, size: 8, font: bold });
  y -= 16;

  const addrLines = [
    ...(d.address.unit ? [d.address.unit] : []),
    d.address.line1,
    `${d.address.city} ${d.address.province}  ${d.address.postal}`,
  ];
  for (const line of addrLines) {
    page.drawText(line, { x: M, y, size: 11, font: sans });
    y -= 14;
  }
  if (d.recipient_phone) {
    page.drawText(d.recipient_phone, { x: M, y, size: 10, font: mono });
    y -= 13;
  }
  if (d.address.note) {
    page.drawText(d.address.note.slice(0, 60), { x: M, y, size: 9, font: sans });
    y -= 12;
  }

  y -= 4;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: BLACK });
  y -= 12;
  page.drawText(d.recipient_locale === 'fr-CA' ? 'DE' : 'FROM', { x: M, y, size: 6.5, font: bold });
  page.drawText(d.from_store, { x: M + 30, y: y - 1, size: 9, font: sans });
  y -= 16;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1.6, color: BLACK });
  y -= 14;

  // box-reference barcode — Code 128, rendered by a real encoder
  const capTxt = d.recipient_locale === 'fr-CA' ? 'RÉFÉRENCE DE BOÎTE' : 'BOX REFERENCE';
  const capW = bold.widthOfTextAtSize(capTxt, 6.5);
  page.drawText(capTxt, { x: (W - capW) / 2, y, size: 6.5, font: bold });
  y -= 6;

  const png = await bwipjs.toBuffer({
    bcid: 'code128', text: d.box_ref, scale: 3, height: 14, includetext: false,
  });
  const img = await doc.embedPng(png);
  const bw = W - 2 * M - 20;
  const bh = (img.height / img.width) * bw;
  page.drawImage(img, { x: M + 10, y: y - bh, width: bw, height: bh });
  y -= bh + 4;

  const refTxt = d.box_ref;
  const refTxtW = bold.widthOfTextAtSize(refTxt, 15);
  page.drawText(refTxt, { x: (W - refTxtW) / 2, y: y - 12, size: 15, font: bold });
  y -= 30;

  // chips: seal · ticket-free zone (ticket ref only), signature+code
  const chips = [
    `SEAL ${d.seal_no}`,
    d.recipient_locale === 'fr-CA' ? 'SIGNATURE + CODE REQUIS' : 'SIGNATURE + CODE REQUIRED',
  ];
  if (d.seal_count > 1) {
    chips.push(d.recipient_locale === 'fr-CA'
      ? `RESCELLÉE ${d.seal_count}×` : `RE-SEALED ${d.seal_count}×`);
  }
  let cx = M;
  for (const c of chips) {
    const cw = mono.widthOfTextAtSize(c, 7.5) + 10;
    if (cx + cw > W - M) { cx = M; y -= 18; }
    page.drawRectangle({ x: cx, y: y - 13, width: cw, height: 14,
      borderColor: BLACK, borderWidth: 1 });
    page.drawText(c, { x: cx + 5, y: y - 9, size: 7.5, font: mono });
    cx += cw + 6;
  }
  y -= 24;

  // copy number, tiny, bottom corner — reprints are chained and counted
  page.drawText(`COPY ${d.copy_number}`, { x: M, y: M - 6, size: 6, font: mono });

  return doc.save();
}
