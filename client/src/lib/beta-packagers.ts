import JSZip from 'jszip';
import { BoardIR } from '@/types/board-ir';
import { AacMaster, AacMasterSchema, validateAacMaster } from '@shared/aac-master-schema';
import { AacMasterConverter } from './aac-master-converter';
import syntaacxLogoUrl from '@assets/SyntAACx logo_1755866035430_1756745771494.png';

// Download utility function
export function downloadFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export class BetaGrid3Packager {
  static async package(board: BoardIR): Promise<Blob> {
    const zip = new JSZip();
    
    // Convert to Master AAC JSON
    const aacMaster = AacMasterConverter.convertFromBoardIR(board);
    
    // Validate the structure
    const validatedData = AacMasterSchema.parse(aacMaster);
    validateAacMaster(validatedData);
    
    // Convert Master AAC to Grid3 format
    const grid3Data = await this.convertToGrid3Format(validatedData);
    
    // Create Grid3 structure
    zip.file("master_aac.json", JSON.stringify(validatedData, null, 2));
    zip.file(`Grids/${validatedData.meta.title}/grid.xml`, grid3Data.gridXml);
    zip.file("Settings0/settings.xml", grid3Data.settingsXml);
    zip.file("Settings0/Styles/styles.xml", grid3Data.stylesXml);
    zip.file("FileMap.xml", grid3Data.fileMapXml);
    
    // Add SyntAACx logo as thumbnail
    try {
      const logoResponse = await fetch(syntaacxLogoUrl);
      if (logoResponse.ok) {
        const logoArrayBuffer = await logoResponse.arrayBuffer();
        zip.file("Settings0/thumbnail.png", logoArrayBuffer);
      }
    } catch (error) {
      console.error('Failed to load SyntAACx logo for beta export:', error);
    }
    
    return await zip.generateAsync({ type: "blob" });
  }
  
  private static async convertToGrid3Format(aacData: AacMaster) {
    const boardName = aacData.meta.title;
    const mainBoard = aacData.boards[0];
    
    // Generate settings.xml
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
  <StartGrid>${boardName}</StartGrid>
  <Language>${aacData.meta.locale}</Language>
  <ThumbnailBackground>#FFFFFFFF</ThumbnailBackground>
  <Thumbnail>.png</Thumbnail>
  <GridSetFileFormatVersion>1</GridSetFileFormatVersion>
  <Comment>Generated from Master AAC JSON by SyntAACx Beta</Comment>
</GridSetSettings>`;

    // Generate styles.xml
    const stylesXml = `<StyleData xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Styles>
    <Style Key="Default" />
    <Style Key="Vocab cell">
      <BackColour>${mainBoard.layout.theme?.default_cell_color || '#D3D3D3FF'}</BackColour>
      <BorderColour>#646464FF</BorderColour>
      <FontColour>#000000FF</FontColour>
    </Style>
  </Styles>
</StyleData>`;

    // Generate grid XML
    const columnDefs = Array(mainBoard.layout.cols).fill('<ColumnDefinition />').join('\n    ');
    const rowDefs = Array(mainBoard.layout.rows).fill('<RowDefinition />').join('\n    ');
    
    console.log('Converting AAC board to Grid3:', {
      boardName: mainBoard.name,
      cellCount: mainBoard.cells.length,
      gridSize: { rows: mainBoard.layout.rows, cols: mainBoard.layout.cols }
    });
    
    const cells = mainBoard.cells.map(cell => {
      console.log('Converting cell:', cell);
      return this.convertCellToGrid3(cell, aacData);
    }).join('\n    ');
    
    const gridXml = `<Grid xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <GridGuid>${this.generateGuid()}</GridGuid>
  <ColumnDefinitions>
    ${columnDefs}
  </ColumnDefinitions>
  <RowDefinitions>
    ${rowDefs}
  </RowDefinitions>
  <AutoContentCommands />
  <Cells>
    ${cells}
  </Cells>
  <ScanBlockAudioDescriptions />
  <WordList>
    <Items />
  </WordList>
</Grid>`;

    // Generate FileMap.xml
    const fileMapXml = `<FileMap xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Entries>
    <Entry StaticFile="Grids\\${boardName}\\grid.xml">
      <DynamicFiles>
      </DynamicFiles>
    </Entry>
  </Entries>
</FileMap>`;

    return {
      settingsXml,
      stylesXml,
      gridXml,
      fileMapXml
    };
  }
  
  private static convertCellToGrid3(cell: any, aacData: AacMaster): string {
    // Master AAC uses 1-based indexing, Grid3 uses 0-based
    const x = (cell.col || 1) - 1; 
    const y = (cell.row || 1) - 1;
    
    console.log('Converting cell to Grid3:', { 
      id: cell.id, 
      label: cell.label, 
      row: cell.row, 
      col: cell.col, 
      x, y,
      actions: cell.actions 
    });
    
    // Get symbol reference
    let imageRef = "[widgit]widgit rebus\\c\\communicate.emf";
    if (cell.symbol_id) {
      const symbol = aacData.assets.symbols?.find(s => s.id === cell.symbol_id);
      if (symbol) {
        imageRef = this.getGrid3SymbolReference(symbol.ref || cell.label);
      }
    } else if (cell.label) {
      // Use label for symbol lookup if no symbol_id
      imageRef = this.getGrid3SymbolReference(cell.label);
    }
    
    // Convert actions to Grid3 commands
    let commands = this.convertActionsToGrid3Commands(cell.actions || [], aacData);
    
    return `<Cell X="${x}" Y="${y}">
      <Content>
        <Commands>${commands}
        </Commands>
        <CaptionAndImage>
          <Caption>${this.escapeXml(cell.label || 'Button')}</Caption>
          <Image>${imageRef}</Image>
        </CaptionAndImage>
        <Style>
          <BasedOnStyle>Vocab cell</BasedOnStyle>
          <BackColour>${cell.style?.bg || '#3B82F6'}FF</BackColour>
        </Style>
      </Content>
    </Cell>`;
  }
  
  private static convertActionsToGrid3Commands(actions: any[], aacData: AacMaster): string {
    if (!actions.length) {
      return `
          <Command ID="Action.InsertText">
            <Parameter Key="text">
              <p><s><r>Button</r></s><s><r><![CDATA[ ]]></r></s></p>
            </Parameter>
          </Command>`;
    }
    
    const action = actions[0]; // Use first action
    console.log('Converting action to Grid3 command:', action);
    
    switch (action.type) {
      case 'speak':
        return `
          <Command ID="Action.InsertText">
            <Parameter Key="text">
              <p><s><r>${this.escapeXml(action.text || 'Button')}</r></s><s><r><![CDATA[ ]]></r></s></p>
            </Parameter>
          </Command>`;
            
      case 'navigate':
        return `
          <Command ID="Grid.JumpToGrid">
            <Parameter Key="gridname">${action.target_board_id}</Parameter>
          </Command>`;
          
      case 'play_video':
        const video = aacData.assets.videos?.find(v => v.id === action.video_id);
        const videoUrl = video?.url || `https://youtube.com/watch?v=${action.video_id}`;
        return `
          <Command ID="WebBrowser.NavigateUrl">
            <Parameter Key="url">${videoUrl}</Parameter>
          </Command>`;
          
      case 'open_url':
        return `
          <Command ID="WebBrowser.NavigateUrl">
            <Parameter Key="url">${action.url}</Parameter>
          </Command>`;
          
      default:
        const text = action.text || action.speak || 'Button';
        return `
          <Command ID="Action.InsertText">
            <Parameter Key="text">
              <p><s><r>${this.escapeXml(text)}</r></s><s><r><![CDATA[ ]]></r></s></p>
            </Parameter>
          </Command>`;
    }
  }
  
  private static getGrid3SymbolReference(symbolName: string): string {
    // Use existing symbol mapping logic
    const symbolMap: { [key: string]: string } = {
      'happy': '[widgit]widgit rebus\\h\\happy.emf',
      'sad': '[widgit]widgit rebus\\s\\sad.emf',
      'eat': '[widgit]widgit rebus\\e\\eat.emf',
      'drink': '[widgit]widgit rebus\\d\\drink.emf',
      'play': '[widgit]widgit rebus\\p\\play.emf',
      'video': '[widgit]widgit rebus\\v\\video.emf',
      'music': '[widgit]widgit rebus\\m\\music.emf'
    };
    
    const mappedSymbol = symbolMap[symbolName.toLowerCase()];
    if (mappedSymbol) return mappedSymbol;
    
    const firstLetter = symbolName.charAt(0).toLowerCase();
    return `[widgit]widgit rebus\\${firstLetter}\\${symbolName.toLowerCase()}.emf`;
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

export class BetaTDSnapPackager {
  static async package(board: BoardIR): Promise<Blob> {
    const zip = new JSZip();
    
    // Convert to Master AAC JSON
    const aacMaster = AacMasterConverter.convertFromBoardIR(board);
    
    // Validate the structure  
    const validatedData = AacMasterSchema.parse(aacMaster);
    validateAacMaster(validatedData);
    
    // Create TD Snap structure with Master AAC basis
    const manifest = {
      name: validatedData.meta.title,
      version: validatedData.meta.version,
      generator: "SyntAACx Beta",
      created: new Date().toISOString(),
      format: "tdsnap-v2-aac-master",
      locale: validatedData.meta.locale,
      authors: validatedData.meta.authors,
      master_aac_version: "1.0"
    };
    
    zip.file("package.json", JSON.stringify(manifest, null, 2));
    zip.file("master_aac.json", JSON.stringify(validatedData, null, 2));
    
    // Convert boards to TD Snap layout format
    validatedData.boards.forEach((board, index) => {
      const pageLayout = this.convertBoardToTDSnapLayout(board, validatedData);
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
      },
      master_aac_compliance: true
    };
    
    zip.file("config.json", JSON.stringify(config, null, 2));
    
    // Add README
    const readme = `# ${validatedData.meta.title}

Generated by SyntAACx Beta using Master AAC JSON format

## Master AAC JSON Compliance
This package includes the standardized Master AAC JSON format in master_aac.json.

## Structure
- package.json: Package metadata
- master_aac.json: Master AAC JSON format
- layouts/: Page layout definitions converted from Master AAC
- config.json: Application settings

## Import Instructions
1. Save this file with .snappkg extension
2. Import into TD Snap
3. Master AAC JSON provides full compatibility and asset references
`;
    
    zip.file("README.txt", readme);
    
    return await zip.generateAsync({ type: "blob" });
  }
  
  private static convertBoardToTDSnapLayout(board: any, aacData: AacMaster) {
    const buttons = board.cells.map((cell: any) => {
      const buttonData: any = {
        cellId: `${cell.row}-${cell.col}`,
        row: cell.row - 1, // Convert back to 0-based
        column: cell.col - 1,
        width: cell.col_span || 1,
        height: cell.row_span || 1,
        label: cell.label || "",
        speech: cell.speak || cell.label || "",
        backgroundColor: cell.style?.bg || "#3B82F6",
        textColor: cell.style?.fg || "#FFFFFF",
        borderColor: "#CCCCCC",
        actions: this.convertActionsToTDSnap(cell.actions || [], aacData),
        visibility: "visible",
        enabled: true,
        // Master AAC JSON references
        aac_cell_id: cell.id,
        aac_symbol_id: cell.symbol_id,
        aac_video_id: cell.video_id,
        aac_audio_id: cell.audio_id
      };
      
      // Handle symbol/icon
      if (cell.symbol_id) {
        const symbol = aacData.assets.symbols?.find(s => s.id === cell.symbol_id);
        if (symbol) {
          buttonData.icon = {
            type: "symbol",
            reference: symbol.ref,
            set: symbol.set,
            color: cell.style?.fg || "#FFFFFF"
          };
        }
      } else {
        buttonData.icon = {
          type: "fontawesome", 
          reference: "fas fa-comment",
          color: cell.style?.fg || "#FFFFFF"
        };
      }
      
      return buttonData;
    });
    
    return {
      pageId: board.id,
      name: board.name,
      gridSize: {
        rows: board.layout.rows,
        cols: board.layout.cols
      },
      buttons,
      master_aac_board_id: board.id
    };
  }
  
  private static convertActionsToTDSnap(actions: any[], aacData: AacMaster) {
    return actions.map(action => {
      switch (action.type) {
        case 'speak':
          return { type: 'speak', text: action.text };
          
        case 'navigate':
          return { type: 'jump', targetPage: action.target_board_id };
          
        case 'back':
          return { type: 'back' };
          
        case 'open_url':
          return { type: 'web', url: action.url };
          
        case 'play_video':
          const video = aacData.assets.videos?.find(v => v.id === action.video_id);
          return { 
            type: 'web', 
            url: video?.url || `https://youtube.com/watch?v=${action.video_id}`,
            aac_video_id: action.video_id
          };
          
        case 'play_audio':
          return { 
            type: 'audio', 
            audioId: action.audio_id,
            aac_audio_id: action.audio_id
          };
          
        default:
          return { type: 'speak', text: action.text || 'Button' };
      }
    });
  }
}