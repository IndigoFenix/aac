import JSZip from 'jszip';
import { BoardIR, PageIR, ActionIR } from '@/types/board-ir';
import { resolveGrid3Path } from './rebus-cleanup';
import { emojiToConcept } from './emoji-to-grid3';

export class GridsetPackager {
  static async package(board: BoardIR): Promise<Blob> {
    const zip = new JSZip();
    const gridName = board.name;
    const gridGuid = this.generateGuid();
    
    // Collect all unique symbols used in the board
    const usedSymbols = new Set<string>();
    board.pages.forEach(page => {
      page.buttons.forEach(button => {
        if (button.symbolPath) {
          const symbolFilename = button.symbolPath.split('/').pop()?.replace('.svg', '');
          if (symbolFilename) {
            usedSymbols.add(symbolFilename);
          }
        }
      });
    });

    // Create a mapping for symbols but don't embed them
    // Instead, we'll use a more compatible approach for Grid3
    const symbolMap = new Map<string, string>();
    for (const symbolFilename of Array.from(usedSymbols)) {
      // Map Mulberry symbols to actual Grid3 Widgit symbol IDs
      const mappedId = this.mapMulberryToWidgit(symbolFilename);
      symbolMap.set(symbolFilename, mappedId);
    }
    
    // Handle cover image - embed SyntAACx logo by default and when selected
    const coverBackground = board.coverImage?.backgroundColor || "#FFFFFFFF"; // White background by default
    let hasThumbnailImage = false;
    
    // Set thumbnail reference based on whether we have the image
    const coverImage = hasThumbnailImage ? ".png" : "[widgit]widgit rebus\\c\\communicate.emf";
    
    const settingsXml = `<GridSetSettings xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
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
  <StartGrid>${gridName}</StartGrid>
  <Language>en-US</Language>
  <ThumbnailBackground>${coverBackground}</ThumbnailBackground>
  <Thumbnail>${coverImage}</Thumbnail>
  <GridSetFileFormatVersion>1</GridSetFileFormatVersion>
</GridSetSettings>`;
    
    zip.file("Settings0/settings.xml", settingsXml);
    
    // Create Settings0/Styles/styles.xml
    const stylesXml = `<StyleData xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Styles>
    <Style Key="Default" />
    <Style Key="Vocab cell">
      <BackColour>#D3D3D3FF</BackColour>
      <BorderColour>#646464FF</BorderColour>
      <FontColour>#000000FF</FontColour>
    </Style>
  </Styles>
</StyleData>`;
    
    zip.file("Settings0/Styles/styles.xml", stylesXml);
    
    // Create the main grid XML for the first page
    const mainPage = board.pages[0];
    const gridXml = this.generateGridXml(gridName, gridGuid, board.grid, mainPage, symbolMap);
    zip.file(`Grids/${gridName}/grid.xml`, gridXml);
    
    // Create FileMap.xml - include thumbnail if we have one
    let dynamicFiles = '';
    if (hasThumbnailImage) {
      dynamicFiles = `
        <File>Settings0\\thumbnail.png</File>`;
    }
    
    const fileMapXml = `<FileMap xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Entries>
    <Entry StaticFile="Settings0\\settings.xml">
      <DynamicFiles>${dynamicFiles}
      </DynamicFiles>
    </Entry>
  </Entries>
</FileMap>`;
    
    zip.file("FileMap.xml", fileMapXml);

    // OPC (Open Packaging Conventions) boilerplate — required for .NET's
    // System.IO.Packaging to recognise this ZIP as a valid package.
    // Without these, Grid3 treats the file as a generic compressed archive.
    const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml" />
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="png" ContentType="image/png" />
</Types>`;
    zip.file("[Content_Types].xml", contentTypesXml);

    const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.thinksmartbox.com/grid3/settings" Target="Settings0/settings.xml" />
</Relationships>`;
    zip.file("_rels/.rels", relsXml);

    return await zip.generateAsync({ type: "blob" });
  }
  
  private static generateGridXml(gridName: string, gridGuid: string, grid: { rows: number; cols: number }, page: any, symbolMap?: Map<string, string>): string {
    // Generate column and row definitions
    const columnDefs = Array(grid.cols).fill('<ColumnDefinition />').join('\n    ');
    const rowDefs = Array(grid.rows).fill('<RowDefinition />').join('\n    ');
    
    // Generate cells from buttons
    const buttonCells = page.buttons.map((button: any) => this.generateCellXml(button, symbolMap));
    
    // Generate cells from video players
    const videoCells = (page.videoPlayers || []).map((videoPlayer: any) => 
      this.generateVideoPlayerCellXml(videoPlayer, symbolMap)
    );
    
    // Combine all cells
    const allCells = [...buttonCells, ...videoCells].join('\n    ');
    
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
    ${allCells}
  </Cells>
  <ScanBlockAudioDescriptions />
  <WordList>
    <Items />
  </WordList>
</Grid>`;
  }
  
  private static generateCellXml(button: any, symbolMap?: Map<string, string>): string {
    // Convert color to Grid3 format (with alpha)
    const color = this.convertColorToGrid3Format(button.color || '#3B82F6');
    const text = button.label || 'Button';
    const spokenText = button.spokenText || button.label || 'Button';

    // Resolve symbol: rebusKey (primary) → emoji lookup (legacy fallback) → label text
    let imageRef: string;
    if (button.rebusKey) {
      // Board has rebusKey — use it directly via cleanup utility
      imageRef = resolveGrid3Path(button.rebusKey, text);
    } else {
      // Legacy board without rebusKey — try emoji → concept, then label
      const emojiConcept = button.iconRef ? emojiToConcept(button.iconRef) : null;
      const conceptOrLabel = emojiConcept || this.translateHebrewToEnglish(text.toLowerCase());
      imageRef = resolveGrid3Path(undefined, conceptOrLabel);
    }
    
    // Handle different action types
    let commands = '';
    if (button.action?.type === 'youtube') {
      // YouTube action using Grid3's proper YouTube integration
      commands = `
          <Command ID="WebBrowser.NavigateUrl">
            <Parameter Key="url">http://youtube.sensorysoftware.com/play.html?${button.action.videoId}</Parameter>
          </Command>`;
    } else {
      // Default speak action
      commands = `
          <Command ID="Action.InsertText">
            <Parameter Key="indicatorenabled">1</Parameter>
            <Parameter Key="text">
              <p>
                <s Image="${imageRef}">
                  <r>${this.escapeXml(text)}</r>
                </s>
                <s>
                  <r><![CDATA[ ]]></r>
                </s>
              </p>
            </Parameter>
            <Parameter Key="showincelllabel">Yes</Parameter>
          </Command>`;
    }
    
    return `<Cell X="${button.col}" Y="${button.row}">
      <Content>
        <Commands>${commands}
        </Commands>
        <CaptionAndImage>
          <Caption>${this.escapeXml(text)}</Caption>
          <Image>${imageRef}</Image>
        </CaptionAndImage>
        <Style>
          <BasedOnStyle>Vocab cell</BasedOnStyle>
          <BackColour>${color}</BackColour>
        </Style>
      </Content>
    </Cell>`;
  }

  private static generateVideoPlayerCellXml(videoPlayer: any, symbolMap?: Map<string, string>): string {
    // Create a video player cell spanning multiple grid cells
    const text = videoPlayer.title || 'Video Player';
    const imageRef = resolveGrid3Path(undefined, 'video player');
    const backgroundColor = this.convertColorToGrid3Format('#1F2937'); // Dark background for video
    
    // Create YouTube web browser command using Grid3's proper integration
    const commands = `
          <Command ID="WebBrowser.NavigateUrl">
            <Parameter Key="url">http://youtube.sensorysoftware.com/play.html?${videoPlayer.videoId}</Parameter>
          </Command>`;
    
    // Generate a cell for each grid position the video player spans
    const cells = [];
    for (let r = 0; r < videoPlayer.rowSpan; r++) {
      for (let c = 0; c < videoPlayer.colSpan; c++) {
        const cellRow = videoPlayer.row + r;
        const cellCol = videoPlayer.col + c;
        
        // Only add content to the top-left cell, others are empty placeholders
        if (r === 0 && c === 0) {
          cells.push(`<Cell X="${cellCol}" Y="${cellRow}">
      <Content>
        <Commands>${commands}
        </Commands>
        <CaptionAndImage>
          <Caption>${this.escapeXml(text)}</Caption>
          <Image>${imageRef}</Image>
        </CaptionAndImage>
        <Style>
          <BasedOnStyle>Vocab cell</BasedOnStyle>
          <BackColour>${backgroundColor}</BackColour>
        </Style>
      </Content>
    </Cell>`);
        } else {
          // Empty placeholder cells for the spanning area
          cells.push(`<Cell X="${cellCol}" Y="${cellRow}">
      <Content>
        <Commands>
          <Command ID="Action.DoNothing" />
        </Commands>
        <CaptionAndImage>
          <Caption></Caption>
          <Image>${imageRef}</Image>
        </CaptionAndImage>
        <Style>
          <BasedOnStyle>Vocab cell</BasedOnStyle>
          <BackColour>${backgroundColor}</BackColour>
        </Style>
      </Content>
    </Cell>`);
        }
      }
    }
    
    return cells.join('\n    ');
  }
  
  private static convertColorToGrid3Format(hexColor: string): string {
    // Ensure hex color has # prefix
    if (!hexColor.startsWith('#')) {
      hexColor = '#' + hexColor;
    }
    
    // Convert #RRGGBB to #RRGGBBFF (add full alpha)
    if (hexColor.length === 7) {
      return hexColor.toUpperCase() + 'FF';
    }
    
    // If already 8 chars, just uppercase
    if (hexColor.length === 9) {
      return hexColor.toUpperCase();
    }
    
    // Fallback
    return '#D3D3D3FF';
  }
  

  private static mapIconToSymbol(iconRef?: string): string {
    // Map common FontAwesome icons to Widgit symbol names that Grid3 should recognize
    const iconMap: { [key: string]: string } = {
      'fas fa-utensils': '[widgit]eat',          // eating/food
      'fas fa-glass-water': '[widgit]drink',     // drinking/water
      'fas fa-restroom': '[widgit]toilet',       // bathroom/toilet
      'fas fa-plus': '[widgit]more',             // more/add
      'fas fa-check': '[widgit]finished',        // finished/done
      'fas fa-thumbs-up': '[widgit]yes',         // yes/good
      'fas fa-thumbs-down': '[widgit]no',        // no/bad
      'fas fa-question': '[widgit]help',         // help/question
      'fas fa-smile': '[widgit]happy',           // happy/smile
      'fas fa-frown': '[widgit]sad',             // sad/unhappy
      'fas fa-heart': '[widgit]love',            // love/heart
      'fas fa-hand': '[widgit]want',             // want/hand
      'fas fa-user': '[widgit]person',           // person/people
      'fas fa-gamepad': '[widgit]play',          // play/games
      'fas fa-tv': '[widgit]tv',                 // tv/watch
      'fas fa-tree': '[widgit]outside',          // outside/nature
      'fas fa-bed': '[widgit]sleep',             // tired/sleep
      'fas fa-female': '[widgit]mum',            // mom/woman
      'fas fa-male': '[widgit]dad',              // dad/man
      'fas fa-fire': '[widgit]hot',              // hot
      'fas fa-snowflake': '[widgit]cold',        // cold
    };
    
    return iconMap[iconRef || ''] || '[widgit]button'; // Default symbol
  }
  
  private static translateHebrewToEnglish(hebrewText: string): string {
    // Map Hebrew words to their English equivalents for symbol mapping
    const hebrewToEnglish: { [key: string]: string } = {
      'רעב': 'hungry',
      'צמא': 'thirsty', 
      'לאכול': 'eat',
      'לשתות': 'drink',
      'עוד': 'more',
      'סיימתי': 'finished',
      'גמר': 'done',
      'נגמר': 'done', 
      'גמרתי': 'done',
      'אין': 'done',
      'all done': 'done',
      'חם': 'hot',
      'קר': 'cold',
      'טוב': 'good',
      'טוב לי': 'good',
      'רע': 'bad',
      'לא טוב': 'bad',
      'כן': 'yes',
      'לא': 'no',
      'עזרה': 'help',
      'שמח': 'happy',
      'עצוב': 'sad',
      'אהבה': 'love',
      'רוצה': 'want',
      'צריך': 'need',
      'לשחק': 'play',
      'טלוויזיה': 'tv',
      'בחוץ': 'outside',
      'לישון': 'sleep',
      'עייף': 'tired',
      'עייף/ה': 'tired',
      'אמא': 'mom',
      'אבא': 'dad',
      'משפחה': 'family',
      'בית': 'home',
      'שירותים': 'toilet',
      'בבקשה': 'please',
      'תודה': 'thank you',
      'שלום': 'hello',
      'להתראות': 'goodbye',
      'להתקלח': 'wash',
      'ללכת': 'go',
      'לחכות': 'wait',
      'מפחד': 'scared',
      'סוס': 'horse',
      'עצור': 'stop',
      'קדימה': 'forward',
      'כועס': 'angry',
      'מבולבל': 'confused',
      'מופתע': 'surprised',
      'נרגש': 'excited',
      'רגוע': 'calm'
    };
    
    return hebrewToEnglish[hebrewText] || hebrewText;
  }



  private static mapMulberryToWidgit(symbolFilename: string): string {
    return resolveGrid3Path(undefined, symbolFilename);
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
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
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
