import JSZip from 'jszip';
import { BoardIR } from '@/types/board-ir';
import syntaacxLogoUrl from '@assets/SyntAACx logo_1755866035430_1756745771494.png';

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
    
    // Always embed the SyntAACx logo as the default cover image
    try {
      console.log('Loading SyntAACx logo from:', syntaacxLogoUrl);
      const logoResponse = await fetch(syntaacxLogoUrl);
      if (logoResponse.ok) {
        const logoArrayBuffer = await logoResponse.arrayBuffer();
        zip.file("Settings0/thumbnail.png", logoArrayBuffer);
        hasThumbnailImage = true;
        console.log('Successfully embedded SyntAACx logo in gridset');
      } else {
        console.error('Failed to load SyntAACx logo - response not ok:', logoResponse.status);
      }
    } catch (error) {
      console.error('Failed to load SyntAACx logo:', error);
    }
    
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
    
    // Use Grid3's built-in symbol search system with proper symbol references
    let imageRef = this.getGrid3SymbolReference(text.toLowerCase());
    
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
    const imageRef = this.getGrid3SymbolReference('video player');
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

  private static getGrid3SymbolReference(text: string): string {
    // First, translate Hebrew to English if needed
    const englishText = this.translateHebrewToEnglish(text);
    
    // Use Grid3's proper file path format for Widgit symbols
    // Based on the working file structure from Grid3
    const symbolMap: { [key: string]: string } = {
      'hungry': '[sstix#]2724.emf',
      'eat': '[widgit]widgit rebus\\e\\eat.emf', 
      'food': '[widgit]widgit rebus\\f\\food.emf',
      'drink': '[widgit]widgit rebus\\d\\drink.emf',
      'thirsty': '[widgit]widgit rebus\\t\\thirsty.emf',
      'water': '[widgit]widgit rebus\\w\\water.emf',
      'more': '[widgit]widgit rebus\\m\\more 1.emf',
      'finished': '[widgit]widgit rebus\\f\\finish.emf',
      'done': '[widgit]widgit rebus\\f\\finish.emf',
      'yes': '[widgit]widgit rebus\\y\\yes.emf',
      'no': '[widgit]widgit rebus\\n\\no.emf',
      'help': '[widgit]widgit rebus\\h\\help.emf',
      'happy': '[widgit]widgit rebus\\h\\happy.emf',
      'sad': '[widgit]widgit rebus\\s\\sad.emf',
      'love': '[widgit]widgit rebus\\l\\love.emf',
      'want': '[widgit]widgit rebus\\w\\want.emf',
      'need': '[widgit]widgit rebus\\n\\need.emf',
      'play': '[widgit]widgit rebus\\p\\play.emf',
      'tv': '[widgit]widgit rebus\\t\\tv.emf',
      'television': '[widgit]widgit rebus\\t\\tv.emf',
      'outside': '[widgit]widgit rebus\\o\\outside.emf',
      'sleep': '[widgit]widgit rebus\\s\\sleep.emf',
      'tired': '[widgit]widgit rebus\\t\\tired.emf',
      'mom': '[widgit]widgit rebus\\m\\mum.emf',
      'mum': '[widgit]widgit rebus\\m\\mum.emf',
      'mother': '[widgit]widgit rebus\\m\\mum.emf',
      'dad': '[widgit]widgit rebus\\d\\dad.emf',
      'father': '[widgit]widgit rebus\\d\\dad.emf',
      'family': '[widgit]widgit rebus\\f\\family.emf',
      'home': '[widgit]widgit rebus\\h\\home.emf',
      'house': '[widgit]widgit rebus\\h\\home.emf',
      'good': '[widgit]widgit rebus\\g\\good.emf',
      'bad': '[widgit]widgit rebus\\b\\bad.emf',
      'hot': '[widgit]widgit rebus\\h\\hot.emf',
      'cold': '[widgit]widgit rebus\\s\\shiver.emf',
      'toilet': '[widgit]widgit rebus\\t\\toilet.emf',
      'bathroom': '[widgit]widgit rebus\\t\\toilet.emf',
      'please': '[widgit]widgit rebus\\p\\please.emf',
      'thank you': '[widgit]widgit rebus\\t\\thank you.emf',
      'thanks': '[widgit]widgit rebus\\t\\thank you.emf',
      'hello': '[widgit]widgit rebus\\h\\hello.emf',
      'hi': '[widgit]widgit rebus\\h\\hello.emf',
      'goodbye': '[widgit]widgit rebus\\g\\goodbye.emf',
      'bye': '[widgit]widgit rebus\\g\\goodbye.emf',
      'wash': '[widgit]widgit rebus\\w\\wash.emf',
      'go': '[widgit]widgit rebus\\g\\go.emf',
      'wait': '[widgit]widgit rebus\\w\\wait.emf',
      'scared': '[widgit]widgit rebus\\s\\scared.emf',
      'horse': '[widgit]widgit rebus\\h\\horse.emf',
      'stop': '[widgit]widgit rebus\\s\\stop.emf',
      'forward': '[widgit]widgit rebus\\f\\forward.emf',
      'angry': '[widgit]widgit rebus\\a\\angry.emf',
      'confused': '[widgit]widgit rebus\\c\\confused.emf',
      'surprised': '[widgit]widgit rebus\\s\\surprised.emf',
      'excited': '[widgit]widgit rebus\\e\\excited.emf',
      'calm': '[widgit]widgit rebus\\c\\calm.emf'
    };
    
    // Use the English translation for symbol mapping
    const mappedSymbol = symbolMap[englishText.toLowerCase()];
    if (mappedSymbol) {
      return mappedSymbol;
    }
    
    // For unmapped words, create a path based on first letter of English word
    const firstLetter = englishText.charAt(0).toLowerCase();
    return `[widgit]widgit rebus\\${firstLetter}\\${englishText.toLowerCase()}.emf`;
  }

  private static mapMulberryToWidgit(symbolFilename: string): string {
    // Since we're now using the main getGrid3SymbolReference function,
    // we can delegate to that function for consistency
    return this.getGrid3SymbolReference(symbolFilename);
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

export class SnappkgPackager {
  static async package(board: BoardIR): Promise<Blob> {
    const zip = new JSZip();
    
    // Create basic TD Snap structure
    const manifest = {
      name: board.name,
      version: "1.0",
      generator: "SyntAACx",
      created: new Date().toISOString(),
      format: "tdsnap-v2",
      grid: board.grid,
      pageCount: board.pages.length
    };
    
    zip.file("package.json", JSON.stringify(manifest, null, 2));
    
    // Add page layouts
    board.pages.forEach((page, index) => {
      // Convert regular buttons
      const buttons = page.buttons.map(button => ({
        cellId: `${button.row}-${button.col}`,
        row: button.row,
        column: button.col,
        text: button.label,
        speech: button.spokenText || button.label,
        backgroundColor: button.color || "#3B82F6",
        iconClass: button.symbolPath ? `mulberry-${button.symbolPath.split('/').pop()?.replace('.svg', '')}` : button.iconRef,
        symbolPath: button.symbolPath, // Include the actual symbol path for TD Snap compatibility
        action: this.convertActionToTDSnap(button.action)
      }));
      
      // Convert video players to buttons
      const videoButtons = (page.videoPlayers || []).map(videoPlayer => ({
        cellId: `${videoPlayer.row}-${videoPlayer.col}`,
        row: videoPlayer.row,
        column: videoPlayer.col,
        rowSpan: videoPlayer.rowSpan,
        colSpan: videoPlayer.colSpan,
        text: videoPlayer.title,
        speech: `Play video: ${videoPlayer.title}`,
        backgroundColor: "#1F2937",
        iconClass: "fa-play-circle",
        action: { type: 'web', url: `https://youtube.com/watch?v=${videoPlayer.videoId}` }
      }));
      
      const pageLayout = {
        pageId: page.id,
        name: page.name,
        gridSize: page.layout || board.grid,
        buttons: [...buttons, ...videoButtons]
      };
      
      zip.file(`layouts/page${index + 1}.json`, JSON.stringify(pageLayout, null, 2));
    });
    
    // Add configuration
    const config = {
      appearance: {
        theme: "default",
        buttonBorder: true,
        spacing: "normal"
      },
      behavior: {
        speakOnSelect: true,
        confirmActions: false
      },
      accessibility: {
        highContrast: false,
        largeText: false
      }
    };
    
    zip.file("config.json", JSON.stringify(config, null, 2));
    
    // Add README
    const readme = `# ${board.name}

Generated by SyntAACx for TD Snap

## Structure
- package.json: Package metadata
- layouts/: Page layout definitions
- config.json: Application settings
- assets/: Icons and media (if any)

## Import Instructions
1. Save this file with .snappkg extension
2. Import into TD Snap
3. Configure settings as needed
`;
    
    zip.file("README.txt", readme);
    
    return await zip.generateAsync({ type: "blob" });
  }
  
  private static convertActionToTDSnap(action: any) {
    if (!action) return null;
    
    switch (action.type) {
      case 'speak':
        return { type: 'speak', text: action.text };
      case 'navigate':
        return { type: 'jump', targetPage: action.toPageId };
      case 'back':
        return { type: 'back' };
      case 'link':
        return { type: 'link', targetBoard: action.toBoardId };
      case 'youtube':
        return { type: 'web', url: `https://youtube.com/watch?v=${action.videoId}` };
      default:
        return null;
    }
  }
}

export class TouchChatPackager {
  static async package(board: BoardIR): Promise<Blob> {
    const zip = new JSZip();
    
    // Create TouchChat vocabulary structure
    const vocabulary = {
      name: board.name,
      version: "1.0",
      generator: "SyntAACx",
      created: new Date().toISOString(),
      format: "touchchat-v1",
      settings: {
        gridSize: board.grid,
        voiceSettings: {
          rate: 0.5,
          volume: 1.0,
          pitch: 0.5
        },
        appearance: {
          backgroundColor: "#FFFFFF",
          borderColor: "#CCCCCC",
          borderWidth: 2,
          fontFamily: "Arial",
          fontSize: 18
        },
        behavior: {
          speakOnSelect: true,
          autoAdvance: false,
          confirmBeforeAction: false
        }
      },
      pages: board.pages.map((page, index) => ({
        id: page.id || `page_${index}`,
        name: page.name || `Page ${index + 1}`,
        layout: page.layout || board.grid,
        isHomePage: index === 0,
        buttons: [
          ...page.buttons.map(button => ({
            id: `btn_${button.row}_${button.col}`,
            row: button.row,
            column: button.col,
            width: 1,
            height: 1,
            label: button.label || "",
            speech: button.spokenText || button.label || "",
            backgroundColor: button.color || "#3B82F6",
            textColor: "#FFFFFF",
            borderColor: "#CCCCCC",
            icon: {
              type: "fontawesome",
              reference: button.iconRef || "fas fa-comment",
              color: "#FFFFFF"
            },
            actions: this.convertButtonActions(button.action),
            visibility: "visible",
            enabled: true
          })),
          ...(page.videoPlayers || []).map(videoPlayer => ({
            id: `video_${videoPlayer.row}_${videoPlayer.col}`,
            row: videoPlayer.row,
            column: videoPlayer.col,
            width: videoPlayer.colSpan,
            height: videoPlayer.rowSpan,
            label: videoPlayer.title || "Video Player",
            speech: `Play video: ${videoPlayer.title}`,
            backgroundColor: "#1F2937",
            textColor: "#FFFFFF",
            borderColor: "#666666",
            icon: {
              type: "fontawesome",
              reference: "fas fa-play-circle",
              color: "#FFFFFF"
            },
            actions: [{
              type: "openUrl",
              url: `https://youtube.com/watch?v=${videoPlayer.videoId}`,
              parameters: {}
            }],
            visibility: "visible",
            enabled: true
          }))
        ]
      })),
      wordList: this.extractWordList(board),
      categories: this.extractCategories(board)
    };
    
    // Main vocabulary file
    zip.file("vocabulary.json", JSON.stringify(vocabulary, null, 2));
    
    // TouchChat configuration
    const config = {
      appVersion: "3.0",
      vocabularyId: this.generateId(),
      lastModified: new Date().toISOString(),
      userLevel: "intermediate",
      features: {
        wordPrediction: true,
        autoCapitalization: true,
        speakMode: "text"
      }
    };
    
    zip.file("config.json", JSON.stringify(config, null, 2));
    
    // Add manifest
    const manifest = {
      name: board.name,
      type: "vocabulary",
      version: "1.0",
      compatibleWith: ["TouchChat HD", "TouchChat Express"],
      files: [
        "vocabulary.json",
        "config.json",
        "README.txt"
      ]
    };
    
    zip.file("manifest.json", JSON.stringify(manifest, null, 2));
    
    // Add README
    const readme = `TouchChat Vocabulary: ${board.name}

Generated by SyntAACx - A tool for creating AAC communication boards

This vocabulary package contains:
- vocabulary.json: Main vocabulary configuration
- config.json: TouchChat-specific settings
- manifest.json: Package metadata

Import Instructions:
1. Save this file with .touchchat extension
2. Import into TouchChat using the app's import feature
3. Configure voice and appearance settings as needed

Note: This file format is based on TouchChat's expected structure.
Some features may require adjustment within the TouchChat app.

Generated on: ${new Date().toLocaleDateString()}
`;
    
    zip.file("README.txt", readme);
    
    return await zip.generateAsync({ type: "blob" });
  }
  
  private static convertButtonActions(action: any) {
    const actions = [];
    
    if (!action) {
      return [{ type: "speak", enabled: true }];
    }
    
    switch (action.type) {
      case 'speak':
        actions.push({
          type: "speak",
          text: action.text,
          enabled: true
        });
        break;
      case 'navigate':
        actions.push({
          type: "navigate",
          targetPage: action.toPageId,
          enabled: true
        });
        break;
      case 'back':
        actions.push({
          type: "back",
          enabled: true
        });
        break;
      case 'link':
        actions.push({
          type: "loadVocabulary",
          targetVocabulary: action.toBoardId,
          enabled: true
        });
        break;
      case 'youtube':
        actions.push({
          type: "openWebPage",
          url: `https://youtube.com/watch?v=${action.videoId}`,
          title: action.title || 'YouTube Video',
          enabled: true
        });
        break;
      default:
        actions.push({
          type: "speak",
          enabled: true
        });
    }
    
    return actions;
  }
  
  private static extractWordList(board: BoardIR): string[] {
    const words = new Set<string>();
    
    board.pages.forEach(page => {
      page.buttons.forEach(button => {
        if (button.label) {
          // Split phrases into individual words
          button.label.split(/\s+/).forEach(word => {
            const cleanWord = word.replace(/[^\w]/g, '').toLowerCase();
            if (cleanWord.length > 1) {
              words.add(cleanWord);
            }
          });
        }
      });
    });
    
    return Array.from(words).sort();
  }
  
  private static extractCategories(board: BoardIR): string[] {
    // Extract potential categories from page names and button labels
    const categories = new Set<string>();
    
    board.pages.forEach(page => {
      if (page.name && page.name !== 'Main') {
        categories.add(page.name);
      }
    });
    
    // Add common AAC categories
    ['Greetings', 'Basic Needs', 'Feelings', 'Actions', 'People', 'Places'].forEach(cat => {
      categories.add(cat);
    });
    
    return Array.from(categories).sort();
  }
  
  private static generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }
}

export class OBZPackager {
  static async package(board: BoardIR): Promise<Blob> {
    try {
      const zip = new JSZip();
      const boardId = this.generateId();
      
      // Create main OBF board structure following the official spec
      const obfBoard = {
        format: "open-board-0.1",
        id: boardId,
        locale: "en",
        name: board.name,
        description_html: `Communication board generated by SyntAACx`,
        buttons: this.convertButtonsToOBF(board),
        grid: {
          rows: board.grid.rows,
          columns: board.grid.cols,
          order: this.generateButtonOrder(board)
        },
        images: this.collectImages(board),
        sounds: []
      };

      // Main board file - add as string content
      const obfContent = JSON.stringify(obfBoard, null, 2);
      zip.file("board.obf", obfContent, { binary: false });

      // Create manifest.json for the OBZ package following spec
      const manifest = {
        format: "open-board-0.1",
        root: "board.obf",
        paths: {
          boards: {
            [boardId]: "board.obf"
          },
          images: {},
          sounds: {}
        }
      };

      // Add manifest as string content
      const manifestContent = JSON.stringify(manifest, null, 2);
      zip.file("manifest.json", manifestContent, { binary: false });

      // Don't call embedImages as it's not needed for URL-based images
      // await this.embedImages(zip, board);

      // Generate the zip with proper compression settings
      return await zip.generateAsync({ 
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: {
          level: 6
        }
      });
    } catch (error) {
      console.error("Error generating OBZ file:", error);
      throw new Error("Failed to generate OBZ file");
    }
  }

  private static convertButtonsToOBF(board: BoardIR): any[] {
    const buttons: any[] = [];
    
    board.pages.forEach(page => {
      // Process regular buttons
      page.buttons.forEach(button => {
        const obfButton: any = {
          id: `btn_${button.row}_${button.col}`,
          label: button.label || ""
        };

        // Add vocalization if different from label
        if (button.spokenText && button.spokenText !== button.label) {
          obfButton.vocalization = button.spokenText;
        }

        // Add image reference if symbol exists
        if (button.symbolPath) {
          obfButton.image_id = this.getImageId(button.symbolPath);
        }

        // Add colors
        if (button.color) {
          obfButton.background_color = this.convertColor(button.color);
        }
        obfButton.border_color = "rgb(204, 204, 204)";

        // Add action if it's not just speaking
        const action = this.convertAction(button.action);
        if (action && action !== "default") {
          obfButton.action = action;
        }

        buttons.push(obfButton);
      });
      
      // Process video players as buttons
      (page.videoPlayers || []).forEach(videoPlayer => {
        const obfButton: any = {
          id: `video_${videoPlayer.row}_${videoPlayer.col}`,
          label: videoPlayer.title || "Video Player",
          vocalization: `Play video: ${videoPlayer.title}`,
          background_color: "rgb(31, 41, 55)",
          border_color: "rgb(102, 102, 102)",
          action: `+https://youtube.com/watch?v=${videoPlayer.videoId}`,
          width: videoPlayer.colSpan || 2,
          height: videoPlayer.rowSpan || 2
        };

        buttons.push(obfButton);
      });
    });

    return buttons;
  }

  private static generateButtonOrder(board: BoardIR): (string | null)[][] {
    const order: (string | null)[][] = [];
    const buttonMap = new Map<string, string>();
    
    // Create button ID mapping from first page
    board.pages[0]?.buttons.forEach(button => {
      const key = `${button.row}-${button.col}`;
      buttonMap.set(key, `btn_${button.row}_${button.col}`);
    });

    // Generate grid order using button IDs
    for (let row = 0; row < board.grid.rows; row++) {
      const rowOrder: (string | null)[] = [];
      for (let col = 0; col < board.grid.cols; col++) {
        const key = `${row}-${col}`;
        if (buttonMap.has(key)) {
          rowOrder.push(buttonMap.get(key)!);
        } else {
          rowOrder.push(null); // Empty cell
        }
      }
      order.push(rowOrder);
    }

    return order;
  }

  private static collectImages(board: BoardIR): any[] {
    const images: any[] = [];
    const imageSet = new Set<string>();

    board.pages.forEach(page => {
      page.buttons.forEach(button => {
        if (button.symbolPath && !imageSet.has(button.symbolPath)) {
          imageSet.add(button.symbolPath);
          images.push({
            id: this.getImageId(button.symbolPath),
            url: button.symbolPath.startsWith('http') ? button.symbolPath : `/api/symbols/svg/${button.symbolPath.split('/').pop()}`,
            content_type: "image/svg+xml",
            width: 100,
            height: 100
          });
        }
      });
    });

    return images;
  }

  private static async embedImages(zip: JSZip, board: BoardIR): Promise<void> {
    // For OBZ format, we'll reference images via URLs in the JSON
    // No need to embed actual image files for this implementation
    // The images array in the OBF contains URLs that AAC apps can fetch
  }

  private static convertAction(action: any): string | undefined {
    if (!action) return undefined;
    
    switch (action.type) {
      case 'navigate':
        return ':home'; // Simplified - would need proper page linking
      case 'back':
        return ':home';
      case 'youtube':
        return `https://youtube.com/watch?v=${action.videoId}`;
      default:
        return undefined; // Default is to speak the label
    }
  }

  private static convertColor(color?: string): string {
    // Convert hex to rgb format required by OBF spec
    if (!color || !color.startsWith('#')) return "rgb(59, 130, 246)";
    
    const hex = color.substring(1);
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    
    return `rgb(${r}, ${g}, ${b})`;
  }

  private static getImageId(symbolPath: string): string {
    // Extract filename and create a stable ID
    const filename = symbolPath.split('/').pop()?.replace('.svg', '') || 'symbol';
    return `img_${filename}`;
  }


  private static generateId(): string {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
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
