import JSZip from 'jszip';
import { BoardIR, ButtonIR, VideoPlayerIR, PageIR, ActionIR } from '@/types/board-ir';
import { resolveGrid3Path } from './rebus-cleanup';
import { emojiToConcept } from './emoji-to-grid3';

export class GridsetPackager {
  static async package(board: BoardIR): Promise<Blob> {
    const zip = new JSZip();

    // Build page ID → name map for Jump.To navigation
    const pageNameMap = new Map<string, string>();
    for (const page of board.pages) {
      pageNameMap.set(page.id, page.name);
    }

    const firstPageName = board.pages[0].name;
    const coverBackground = board.coverImage?.backgroundColor || "#FFFFFFFF";
    const coverImage = board.coverImage?.symbolPath || "[widgit]widgit rebus\\c\\communicate.emf";

    // --- Settings0/settings.xml ---
    zip.file("Settings0/settings.xml", `<GridSetSettings xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <PictureSearch>
    <PictureSearchKeys>
      <PictureSearchKey>widgit</PictureSearchKey>
      <PictureSearchKey>sstix#</PictureSearchKey>
      <PictureSearchKey>mjpcs#</PictureSearchKey>
      <PictureSearchKey>ssnaps</PictureSearchKey>
    </PictureSearchKeys>
  </PictureSearch>
  <Appearance>
    <Theme>Kids</Theme>
  </Appearance>
  <StartGrid>${this.escapeXml(firstPageName)}</StartGrid>
  <Language>en-US</Language>
  <ThumbnailBackground>${coverBackground}</ThumbnailBackground>
  <Thumbnail>${coverImage}</Thumbnail>
  <GridSetFileFormatVersion>1</GridSetFileFormatVersion>
</GridSetSettings>`);

    // --- Settings0/Styles/styles.xml ---
    zip.file("Settings0/Styles/styles.xml", `<StyleData xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Styles>
    <Style Key="Default" />
    <Style Key="Vocab cell">
      <BackColour>#D3D3D3FF</BackColour>
      <BorderColour>#646464FF</BorderColour>
      <FontColour>#000000FF</FontColour>
    </Style>
    <Style Key="Navigation cell">
      <BackColour>#2C82C9FF</BackColour>
      <BorderColour>#2C82C9FF</BorderColour>
      <FontColour>#FFFFFFFF</FontColour>
    </Style>
  </Styles>
</StyleData>`);

    // --- Grids/{pageName}/grid.xml per page ---
    const fileMapEntries: string[] = [];
    for (const page of board.pages) {
      const layout = page.layout || board.grid;
      const gridXml = this.generateGridXml(layout, page, pageNameMap);
      zip.file(`Grids/${page.name}/grid.xml`, gridXml);
      fileMapEntries.push(
        `    <Entry StaticFile="Grids\\${page.name}\\grid.xml">\n      <DynamicFiles />\n    </Entry>`
      );
    }

    // Settings entry in FileMap
    fileMapEntries.push(
      `    <Entry StaticFile="Settings0\\settings.xml">\n      <DynamicFiles />\n    </Entry>`
    );

    // --- FileMap.xml ---
    zip.file("FileMap.xml", `<FileMap xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Entries>
${fileMapEntries.join('\n')}
  </Entries>
</FileMap>`);

    return await zip.generateAsync({ type: "blob" });
  }

  // --------------- Grid XML builder ---------------

  private static generateGridXml(
    layout: { rows: number; cols: number },
    page: PageIR,
    pageNameMap: Map<string, string>,
  ): string {
    const gridGuid = this.generateGuid();
    const columnDefs = Array(layout.cols).fill('    <ColumnDefinition />').join('\n');
    const rowDefs = Array(layout.rows).fill('    <RowDefinition />').join('\n');

    // Track every position occupied by a button or video span
    const occupied = new Set<string>();
    const cells: string[] = [];

    // Regular buttons (1×1 cells)
    for (const btn of page.buttons) {
      occupied.add(`${btn.col},${btn.row}`);
      cells.push(this.generateButtonCell(btn, pageNameMap));
    }

    // Video players (spanning cells)
    for (const vp of page.videoPlayers || []) {
      for (let r = 0; r < vp.rowSpan; r++) {
        for (let c = 0; c < vp.colSpan; c++) {
          occupied.add(`${vp.col + c},${vp.row + r}`);
        }
      }
      cells.push(this.generateVideoCell(vp));
    }

    // Fill every remaining position with an empty Default cell
    for (let row = 0; row < layout.rows; row++) {
      for (let col = 0; col < layout.cols; col++) {
        if (!occupied.has(`${col},${row}`)) {
          cells.push(
            `    <Cell X="${col}" Y="${row}">\n` +
            `      <Content>\n` +
            `        <Style>\n` +
            `          <BasedOnStyle>Default</BasedOnStyle>\n` +
            `        </Style>\n` +
            `      </Content>\n` +
            `    </Cell>`
          );
        }
      }
    }

    return `<Grid xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <GridGuid>${gridGuid}</GridGuid>
  <ColumnDefinitions>
${columnDefs}
  </ColumnDefinitions>
  <RowDefinitions>
${rowDefs}
  </RowDefinitions>
  <AutoContentCommands />
  <Cells>
${cells.join('\n')}
  </Cells>
  <ScanBlockAudioDescriptions />
  <WordList>
    <Items />
  </WordList>
</Grid>`;
  }

  // --------------- Button cell ---------------

  private static generateButtonCell(
    button: ButtonIR,
    pageNameMap: Map<string, string>,
  ): string {
    const color = this.convertColorToGrid3Format(button.color || '#3B82F6');
    const text = button.label || 'Button';
    const action = button.action;

    // Resolve Widgit symbol path
    let imageRef: string;
    if (button.rebusKey) {
      imageRef = resolveGrid3Path(button.rebusKey, text);
    } else {
      const emojiConcept = button.iconRef ? emojiToConcept(button.iconRef) : null;
      const conceptOrLabel = emojiConcept || this.translateHebrewToEnglish(text.toLowerCase());
      imageRef = resolveGrid3Path(undefined, conceptOrLabel);
    }

    // Build <Command> list
    const commands: string[] = [];

    if (action?.type === 'youtube') {
      commands.push(
        `          <Command ID="WebBrowser.NavigateUrl">\n` +
        `            <Parameter Key="url">http://youtube.sensorysoftware.com/play.html?${action.videoId}</Parameter>\n` +
        `          </Command>`
      );
    } else if (action?.type === 'navigate' || action?.type === 'link') {
      // Insert text, then jump to the target grid
      commands.push(this.makeInsertTextCommand(imageRef, text));
      const targetName = pageNameMap.get(action.toPageId) || action.toPageId;
      commands.push(
        `          <Command ID="Jump.To">\n` +
        `            <Parameter Key="grid">${this.escapeXml(targetName)}</Parameter>\n` +
        `          </Command>`
      );
    } else if (action?.type === 'back') {
      commands.push(`          <Command ID="Jump.Back" />`);
    } else if (action?.type === 'home') {
      // Home: just jump, no text insertion
    } else {
      // Default: speak the label
      commands.push(this.makeInsertTextCommand(imageRef, text));
    }

    // Choose style and image based on action type
    let styleName = 'Vocab cell';
    let cellImage = imageRef;
    if (action?.type === 'navigate' || action?.type === 'link') {
      styleName = 'Navigation cell';
    } else if (action?.type === 'back') {
      styleName = 'Navigation cell';
      cellImage = '[GRID3X]jump_back.wmf';
    } else if (action?.type === 'home') {
      styleName = 'Navigation cell';
      cellImage = '[GRID3X]jump_home.wmf';
    }

    const commandsXml = commands.length > 0
      ? `\n        <Commands>\n${commands.join('\n')}\n        </Commands>`
      : '';

    return (
      `    <Cell X="${button.col}" Y="${button.row}">` +
      `\n      <Content>${commandsXml}` +
      `\n        <CaptionAndImage>` +
      `\n          <Caption>${this.escapeXml(text)}</Caption>` +
      `\n          <Image>${cellImage}</Image>` +
      `\n        </CaptionAndImage>` +
      `\n        <Style>` +
      `\n          <BasedOnStyle>${styleName}</BasedOnStyle>` +
      `\n          <BackColour>${color}</BackColour>` +
      `\n        </Style>` +
      `\n      </Content>` +
      `\n    </Cell>`
    );
  }

  // --------------- Video cell (with ColumnSpan/RowSpan) ---------------

  private static generateVideoCell(vp: VideoPlayerIR): string {
    const text = vp.title || 'Video Player';
    const imageRef = resolveGrid3Path(undefined, 'video player');
    const bgColor = this.convertColorToGrid3Format('#1F2937');

    return (
      `    <Cell X="${vp.col}" Y="${vp.row}" ColumnSpan="${vp.colSpan}" RowSpan="${vp.rowSpan}">` +
      `\n      <Content>` +
      `\n        <Commands>` +
      `\n          <Command ID="WebBrowser.NavigateUrl">` +
      `\n            <Parameter Key="url">http://youtube.sensorysoftware.com/play.html?${vp.videoId}</Parameter>` +
      `\n          </Command>` +
      `\n        </Commands>` +
      `\n        <CaptionAndImage>` +
      `\n          <Caption>${this.escapeXml(text)}</Caption>` +
      `\n          <Image>${imageRef}</Image>` +
      `\n        </CaptionAndImage>` +
      `\n        <Style>` +
      `\n          <BasedOnStyle>Vocab cell</BasedOnStyle>` +
      `\n          <BackColour>${bgColor}</BackColour>` +
      `\n        </Style>` +
      `\n      </Content>` +
      `\n    </Cell>`
    );
  }

  // --------------- Insert-text command helper ---------------

  private static makeInsertTextCommand(imageRef: string, text: string): string {
    return (
      `          <Command ID="Action.InsertText">\n` +
      `            <Parameter Key="indicatorenabled">1</Parameter>\n` +
      `            <Parameter Key="text">\n` +
      `              <p>\n` +
      `                <s Image="${imageRef}">\n` +
      `                  <r>${this.escapeXml(text)}</r>\n` +
      `                </s>\n` +
      `                <s>\n` +
      `                  <r><![CDATA[ ]]></r>\n` +
      `                </s>\n` +
      `              </p>\n` +
      `            </Parameter>\n` +
      `            <Parameter Key="showincelllabel">Yes</Parameter>\n` +
      `          </Command>`
    );
  }

  // --------------- Helpers ---------------

  private static convertColorToGrid3Format(hexColor: string): string {
    if (!hexColor.startsWith('#')) hexColor = '#' + hexColor;
    if (hexColor.length === 7) return hexColor.toUpperCase() + 'FF';
    if (hexColor.length === 9) return hexColor.toUpperCase();
    return '#D3D3D3FF';
  }

  private static translateHebrewToEnglish(hebrewText: string): string {
    const map: Record<string, string> = {
      'רעב': 'hungry', 'צמא': 'thirsty', 'לאכול': 'eat', 'לשתות': 'drink',
      'עוד': 'more', 'סיימתי': 'finished', 'גמר': 'done', 'נגמר': 'done',
      'גמרתי': 'done', 'אין': 'done', 'all done': 'done', 'חם': 'hot',
      'קר': 'cold', 'טוב': 'good', 'טוב לי': 'good', 'רע': 'bad',
      'לא טוב': 'bad', 'כן': 'yes', 'לא': 'no', 'עזרה': 'help',
      'שמח': 'happy', 'עצוב': 'sad', 'אהבה': 'love', 'רוצה': 'want',
      'צריך': 'need', 'לשחק': 'play', 'טלוויזיה': 'tv', 'בחוץ': 'outside',
      'לישון': 'sleep', 'עייף': 'tired', 'עייף/ה': 'tired', 'אמא': 'mom',
      'אבא': 'dad', 'משפחה': 'family', 'בית': 'home', 'שירותים': 'toilet',
      'בבקשה': 'please', 'תודה': 'thank you', 'שלום': 'hello',
      'להתראות': 'goodbye', 'להתקלח': 'wash', 'ללכת': 'go',
      'לחכות': 'wait', 'מפחד': 'scared', 'סוס': 'horse', 'עצור': 'stop',
      'קדימה': 'forward', 'כועס': 'angry', 'מבולבל': 'confused',
      'מופתע': 'surprised', 'נרגש': 'excited', 'רגוע': 'calm',
    };
    return map[hebrewText] || hebrewText;
  }

  private static escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private static generateGuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}

/**
 * OBZ Packager — Open Board Format (OBF 0.1) compliant
 *
 * Produces a .obz ZIP containing:
 *   manifest.json          — root board + path mappings
 *   boards/{pageId}.obf    — one OBF JSON per page
 *   images/{id}.png        — embedded custom symbol images
 *
 * Spec reference: https://www.openboardformat.org/docs
 */
export class OBZPackager {
  static async package(board: BoardIR): Promise<Blob> {
    const zip = new JSZip();
    const boardPaths: Record<string, string> = {};
    const imagePaths: Record<string, string> = {};

    // Collect and fetch all unique symbol images across pages
    const imageMap = await this.collectAndFetchImages(board);

    // Embed fetched images into the ZIP
    for (const [imageId, imageData] of imageMap.entries()) {
      const imgPath = `images/${imageId}.png`;
      zip.file(imgPath, imageData.blob);
      imagePaths[imageId] = imgPath;
    }

    // Generate an OBF file per page
    for (const page of board.pages) {
      const obfPath = `boards/${page.id}.obf`;
      const obf = this.buildObfBoard(page, board, imageMap);
      zip.file(obfPath, JSON.stringify(obf, null, 2));
      boardPaths[page.id] = obfPath;
    }

    // Manifest
    const rootPage = board.pages[0];
    zip.file("manifest.json", JSON.stringify({
      format: "open-board-0.1",
      root: `boards/${rootPage.id}.obf`,
      paths: {
        boards: boardPaths,
        images: imagePaths,
        sounds: {},
      },
    }, null, 2));

    return zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
  }

  // --------------- OBF board builder ---------------

  private static buildObfBoard(
    page: PageIR,
    board: BoardIR,
    imageMap: Map<string, { blob: Blob; contentType: string }>,
  ) {
    const layout = page.layout || board.grid;
    const buttons: any[] = [];
    const images: any[] = [];
    const seenImages = new Set<string>();

    // Regular buttons
    for (const btn of page.buttons) {
      const obf: any = {
        id: btn.id,
        label: btn.label || "",
      };

      if (btn.spokenText && btn.spokenText !== btn.label) {
        obf.vocalization = btn.spokenText;
      }
      if (btn.color) {
        obf.background_color = this.hexToRgb(btn.color);
      }
      obf.border_color = "rgb(204, 204, 204)";

      // Image
      if (btn.symbolPath) {
        const imgId = this.symbolPathToImageId(btn.symbolPath);
        obf.image_id = imgId;
        if (!seenImages.has(imgId) && imageMap.has(imgId)) {
          seenImages.add(imgId);
          images.push({
            id: imgId,
            path: `images/${imgId}.png`,
            content_type: "image/png",
            width: 256,
            height: 256,
          });
        }
      }

      // Action
      this.applyAction(obf, btn.action);

      // Extension: rebusKey
      if (btn.rebusKey) {
        obf.ext_syntaacx_rebus_key = btn.rebusKey;
      }

      buttons.push(obf);
    }

    // Video players → buttons
    for (const vp of page.videoPlayers || []) {
      buttons.push({
        id: vp.id,
        label: vp.title || "Video",
        vocalization: `Play video: ${vp.title}`,
        background_color: "rgb(31, 41, 55)",
        border_color: "rgb(102, 102, 102)",
        url: `https://youtube.com/watch?v=${vp.videoId}`,
      });
    }

    return {
      format: "open-board-0.1",
      id: page.id,
      locale: "en",
      name: page.name || board.name,
      description_html: page.description || `Communication board page: ${page.name}`,
      buttons,
      grid: {
        rows: layout.rows,
        columns: layout.cols,
        order: this.buildGridOrder(page, layout),
      },
      images,
      sounds: [],
    };
  }

  // --------------- actions ---------------

  private static applyAction(obf: any, action?: ActionIR) {
    if (!action) return; // default OBF behaviour: speak the label

    switch (action.type) {
      case "speak":
        obf.action = `+${action.text}`;
        break;
      case "navigate":
        obf.load_board = { path: `boards/${action.toPageId}.obf` };
        break;
      case "link":
        obf.load_board = { path: `boards/${action.toPageId}.obf` };
        break;
      case "back":
      case "home":
        obf.action = ":home";
        break;
      case "youtube":
        obf.url = `https://youtube.com/watch?v=${action.videoId}`;
        break;
    }
  }

  // --------------- grid order ---------------

  private static buildGridOrder(
    page: PageIR,
    layout: { rows: number; cols: number },
  ): (string | null)[][] {
    const posMap = new Map<string, string>();
    for (const b of page.buttons) posMap.set(`${b.row}-${b.col}`, b.id);
    for (const v of page.videoPlayers || []) posMap.set(`${v.row}-${v.col}`, v.id);

    const order: (string | null)[][] = [];
    for (let r = 0; r < layout.rows; r++) {
      const row: (string | null)[] = [];
      for (let c = 0; c < layout.cols; c++) {
        row.push(posMap.get(`${r}-${c}`) || null);
      }
      order.push(row);
    }
    return order;
  }

  // --------------- image collection ---------------

  private static async collectAndFetchImages(
    board: BoardIR,
  ): Promise<Map<string, { blob: Blob; contentType: string }>> {
    const map = new Map<string, { blob: Blob; contentType: string }>();
    const seen = new Set<string>();
    const fetches: Promise<void>[] = [];

    for (const page of board.pages) {
      for (const btn of page.buttons) {
        if (!btn.symbolPath || seen.has(btn.symbolPath)) continue;
        seen.add(btn.symbolPath);

        const imgId = this.symbolPathToImageId(btn.symbolPath);
        fetches.push(
          this.fetchImage(btn.symbolPath)
            .then(res => { if (res) map.set(imgId, res); })
            .catch(() => { /* skip unfetchable images */ }),
        );
      }
    }

    await Promise.all(fetches);
    return map;
  }

  private static async fetchImage(
    src: string,
  ): Promise<{ blob: Blob; contentType: string } | null> {
    try {
      const res = await fetch(src.startsWith("http") ? src : src);
      if (!res.ok) return null;
      const blob = await res.blob();
      return { blob, contentType: blob.type || "image/png" };
    } catch {
      return null;
    }
  }

  // --------------- helpers ---------------

  private static symbolPathToImageId(symbolPath: string): string {
    // Custom symbol: /api/custom-symbols/{uuid}/image
    const custom = symbolPath.match(/custom-symbols\/([^/]+)\/image/);
    if (custom) return `custom_${custom[1]}`;
    // Mulberry or other: use filename stem
    const filename = symbolPath.split("/").pop()?.replace(/\.\w+$/, "") || "symbol";
    return `img_${filename}`;
  }

  private static hexToRgb(hex: string): string {
    if (!hex?.startsWith("#")) return "rgb(59, 130, 246)";
    const h = hex.substring(1);
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgb(${r}, ${g}, ${b})`;
  }
}

export async function downloadFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
