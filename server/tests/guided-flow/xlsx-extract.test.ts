/**
 * A roster arrives as a spreadsheet more often than anything else, and until
 * Phase D the chat handed the model raw OOXML: `<c r="A1" t="s"><v>0</v></c>`,
 * where the value is an INDEX into a second file and a birth date is the bare
 * number 39448. The model could not read it, so an entire school's onboarding
 * fell back to "type them in one at a time".
 *
 * The three things that silently break the conversion are all asserted here:
 *   1. SHARED STRINGS. Every text cell in a real workbook is an index. Miss the
 *      table and every name in the roster reads as an integer.
 *   2. DATE STYLES. A date IS a number; only the cell's style says otherwise.
 *      A wrong reading here does not throw — it produces "39448" as a birth
 *      date, which the roster normaliser then flags as unreadable and a human
 *      re-types for every child in the class.
 *   3. THE FALLBACK. A .docx is also a zip, and also has no `xl/workbook.xml`.
 *      The old raw-entry behaviour has to survive for it.
 *
 * The fixture is built through JSZip in-test rather than checked in, so the
 * assertion is about the READER, not about one file some spreadsheet program
 * happened to emit.
 */

import { describe, it, expect } from "@jest/globals";
import JSZip from "jszip";

import { excelSerialToIsoDate, extractDocument } from "../../services/chat/file-extractor.js";

// ---------------------------------------------------------------------------
// Fixture — a minimal but real .xlsx
// ---------------------------------------------------------------------------

interface Cell {
  /** "s" = shared string, "n" = number, "d" = number carrying a date style. */
  type: "s" | "n" | "d" | "inline";
  value: string | number;
}

/** styles.xml: xf 0 is General, xf 1 is built-in date format 14. */
const STYLES_XML = `<?xml version="1.0"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs>
</styleSheet>`;

function sheetXml(rows: Cell[][]): string {
  const body = rows
    .map((cells, r) => {
      const inner = cells
        .map((cell, c) => {
          const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
          if (cell.type === "s") return `<c r="${ref}" t="s"><v>${cell.value}</v></c>`;
          if (cell.type === "inline")
            return `<c r="${ref}" t="inlineStr"><is><t>${cell.value}</t></is></c>`;
          // A date cell is a plain number wearing style index 1.
          const style = cell.type === "d" ? ' s="1"' : "";
          return `<c r="${ref}"${style}><v>${cell.value}</v></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${inner}</row>`;
    })
    .join("");
  return `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

async function buildXlsx(args: {
  sheets: Array<{ name: string; rows: Cell[][] }>;
  shared: string[];
}): Promise<string> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets>${args.sheets
      .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join("")}</sheets></workbook>`,
  );
  zip.file(
    "xl/sharedStrings.xml",
    `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${args.shared.length}">${args.shared
      .map((s) => `<si><t>${s}</t></si>`)
      .join("")}</sst>`,
  );
  zip.file("xl/styles.xml", STYLES_XML);
  args.sheets.forEach((s, i) => {
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows));
  });
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${buf.toString("base64")}`;
}

/** A roster the way a school actually exports one. */
const SHARED = [
  "First name",
  "Last name",
  "Birth date",
  "Guardian email",
  "Noa",
  "Levi",
  "parent@example.com",
  "Omar",
  "Haddad",
  "omar.parent@example.com",
];

async function rosterWorkbook(): Promise<string> {
  return buildXlsx({
    shared: SHARED,
    sheets: [
      {
        name: "Class 3B",
        rows: [
          [
            { type: "s", value: 0 },
            { type: "s", value: 1 },
            { type: "s", value: 2 },
            { type: "s", value: 3 },
          ],
          [
            { type: "s", value: 4 },
            { type: "s", value: 5 },
            // 39448 = 2008-01-01
            { type: "d", value: 39448 },
            { type: "s", value: 6 },
          ],
          [
            { type: "s", value: 7 },
            { type: "s", value: 8 },
            { type: "d", value: 40179 },
            { type: "s", value: 9 },
          ],
        ],
      },
    ],
  });
}

// ---------------------------------------------------------------------------

describe("excelSerialToIsoDate", () => {
  it("maps the serials a school roster actually contains", () => {
    expect(excelSerialToIsoDate(39448)).toBe("2008-01-01");
    expect(excelSerialToIsoDate(40179)).toBe("2010-01-01");
    // 1900-03-01, the first day after Excel's phantom leap day.
    expect(excelSerialToIsoDate(61)).toBe("1900-03-01");
  });

  it("refuses values that are not plausible dates", () => {
    expect(excelSerialToIsoDate(0)).toBeNull();
    expect(excelSerialToIsoDate(-5)).toBeNull();
    expect(excelSerialToIsoDate(Number.NaN)).toBeNull();
    expect(excelSerialToIsoDate(9e9)).toBeNull();
  });
});

describe("extractDocument — xlsx", () => {
  it("resolves shared strings instead of emitting their indexes", async () => {
    const result = await extractDocument(await rosterWorkbook(), "roster.xlsx");
    expect(result.extracted).toBe(true);
    expect(result.text).toContain("Noa,Levi");
    expect(result.text).toContain("Omar,Haddad");
    expect(result.text).toContain("parent@example.com");
    // The raw OOXML the old path produced.
    expect(result.text).not.toContain("<c r=");
    expect(result.text).not.toContain("sharedStrings");
  });

  it("converts a date-styled number to an ISO date", async () => {
    const result = await extractDocument(await rosterWorkbook(), "roster.xlsx");
    expect(result.text).toContain("2008-01-01");
    expect(result.text).toContain("2010-01-01");
    // The serial itself must NOT survive: a model shown 39448 will either
    // invent a date or mark the row unreadable.
    expect(result.text).not.toContain("39448");
  });

  it("leaves a number with no date style alone", async () => {
    const dataUrl = await buildXlsx({
      shared: ["Score"],
      sheets: [
        {
          name: "Sheet1",
          rows: [
            [
              { type: "s", value: 0 },
              { type: "n", value: 39448 },
            ],
          ],
        },
      ],
    });
    const result = await extractDocument(dataUrl, "scores.xlsx");
    expect(result.text).toContain("Score,39448");
  });

  it("names every sheet and keeps them in workbook order", async () => {
    const dataUrl = await buildXlsx({
      shared: ["A", "B"],
      sheets: [
        { name: "Morning", rows: [[{ type: "s", value: 0 }]] },
        { name: "Afternoon", rows: [[{ type: "s", value: 1 }]] },
      ],
    });
    const result = await extractDocument(dataUrl, "two.xlsx");
    const text = result.text ?? "";
    expect(text).toContain("# sheet: Morning");
    expect(text).toContain("# sheet: Afternoon");
    expect(text.indexOf("# sheet: Morning")).toBeLessThan(text.indexOf("# sheet: Afternoon"));
  });

  it("quotes cells that would otherwise break the CSV", async () => {
    const dataUrl = await buildXlsx({
      shared: ['Levi, Noa', 'She said "hi"'],
      sheets: [
        {
          name: "Sheet1",
          rows: [
            [
              { type: "s", value: 0 },
              { type: "s", value: 1 },
            ],
          ],
        },
      ],
    });
    const result = await extractDocument(dataUrl, "commas.xlsx");
    expect(result.text).toContain('"Levi, Noa"');
    expect(result.text).toContain('"She said ""hi"""');
  });

  it("reads an inline string (a workbook with no shared table)", async () => {
    const dataUrl = await buildXlsx({
      shared: [],
      sheets: [{ name: "Sheet1", rows: [[{ type: "inline", value: "Dana" }]] }],
    });
    const result = await extractDocument(dataUrl, "inline.xlsx");
    expect(result.text).toContain("Dana");
  });

  it("keeps empty cells as empty columns so the header line still lines up", async () => {
    const dataUrl = await buildXlsx({
      shared: ["First", "Last", "Noa"],
      sheets: [
        {
          name: "Sheet1",
          rows: [
            [
              { type: "s", value: 0 },
              { type: "s", value: 1 },
            ],
            // Only column B is present in the XML; column A must still be a
            // column, or every value after a gap shifts one field left.
            [],
          ],
        },
      ],
    });
    const zip = await JSZip.loadAsync(Buffer.from(dataUrl.split(",")[1], "base64"));
    zip.file(
      "xl/worksheets/sheet1.xml",
      `<?xml version="1.0"?><worksheet><sheetData>` +
        `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>` +
        `<row r="2"><c r="B2" t="s"><v>2</v></c></row>` +
        `</sheetData></worksheet>`,
    );
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const result = await extractDocument(
      `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${buf.toString("base64")}`,
      "gap.xlsx",
    );
    expect(result.text).toContain(",Noa");
  });

  it("falls back to the raw-zip listing for a zip that is not a workbook", async () => {
    // A .docx: same magic bytes, no xl/workbook.xml.
    const zip = new JSZip();
    zip.file("word/document.xml", "<w:document>hello</w:document>");
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const result = await extractDocument(
      `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${buf.toString("base64")}`,
      "letter.docx",
    );
    expect(result.extracted).toBe(true);
    expect(result.text).toContain("word/document.xml");
    expect(result.text).not.toContain("converted to CSV");
  });
});
