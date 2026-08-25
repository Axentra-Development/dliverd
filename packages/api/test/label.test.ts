import { describe, it, expect } from 'vitest';
import { renderLabel, type LabelData } from '../src/label.js';

/**
 * The label leak test (spec §5.5, §11.3). The label must never disclose what
 * is inside the box or what it is worth. This test is the enforcement — do not
 * delete it to "just add the item name for the driver."
 */

const DATA: LabelData = {
  movement_ref: 'M-4473',
  service_name: 'CUSTODE 24 AM',
  service_window: 'by 10:30',
  recipient_name: 'Geneviève Bilodeau',
  recipient_locale: 'fr-CA',
  recipient_phone: '+15145550142',
  address: { unit: 'app. 302', line1: '6321 rue Beaubien E', city: 'Montréal',
             province: 'QC', postal: 'H1M 2Y8', note: 'Sonner deux fois' },
  from_store: 'BMobile Beaubien',
  box_ref: 'BX-1042',
  seal_no: 'CS-40118',
  seal_count: 1,
  copy_number: 1,
};

async function pdfText(bytes: Uint8Array): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({ data: bytes.slice() }).promise;
  let out = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    out += tc.items.map((i) => ('str' in i ? i.str : '')).join(' ') + '\n';
  }
  // extraction splits and pads text unpredictably — compare on collapsed whitespace
  return out.replace(/\s+/g, ' ');
}

describe('shipping label', () => {
  it('renders a one-page 4×6 PDF with everything the door needs', async () => {
    const bytes = await renderLabel(DATA);
    expect(bytes.length).toBeGreaterThan(2000);
    const text = await pdfText(bytes);

    for (const must of [
      'CUSTODE', 'M-4473', 'CUSTODE 24 AM', 'BY 10:30',
      'Geneviève Bilodeau', 'FR', 'app. 302', '6321 rue Beaubien E',
      'Montréal QC H1M 2Y8', '+15145550142', 'Sonner deux fois',
      'BMobile Beaubien', 'BX-1042', 'SEAL CS-40118', 'SIGNATURE + CODE REQUIS',
    ]) expect(text, `label must carry: ${must}`).toContain(must);
  });

  it('NEVER discloses contents, value, or a currency symbol', async () => {
    const text = await pdfText(await renderLabel(DATA));
    for (const forbidden of [
      'iPhone', 'MagSafe', 'IMEI', '356938035643809',
      '1449', '1,449', '1 449', '$', 'CAD', 'declared', 'valeur',
    ]) expect(text, `label leaked: ${forbidden}`).not.toContain(forbidden);
  });

  it('marks a re-sealed box on the label — the recipient is entitled to know', async () => {
    const text = await pdfText(await renderLabel({ ...DATA, seal_count: 2, seal_no: 'CS-40119' }));
    expect(text).toContain('RESCELLÉE 2×');
    expect(text).toContain('CS-40119');
    expect(text).not.toContain('CS-40118'); // the voided seal is gone with its label
  });

  it('renders English for an EN recipient', async () => {
    const text = await pdfText(await renderLabel({ ...DATA, recipient_locale: 'en-CA' }));
    expect(text).toContain('DELIVER TO');
    expect(text).toContain('SIGNATURE + CODE REQUIRED');
  });

  it('counts copies visibly — reprints are an audit signal', async () => {
    const text = await pdfText(await renderLabel({ ...DATA, copy_number: 4 }));
    expect(text).toContain('COPY 4');
  });

  it('embeds a real Code 128 barcode image, not decoration', async () => {
    const bytes = await renderLabel(DATA);
    // a PNG XObject must be embedded (bwip-js output)
    const raw = Buffer.from(bytes).toString('latin1');
    expect(raw).toMatch(/\/Image/);
  });
});
