import * as vscode from 'vscode'
import { getTinyFileUriFromPosition } from './util'
import * as _ from 'lodash'

export class TinyHoverProvider implements vscode.HoverProvider {
   public async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | null> {
      const file_uri = await getTinyFileUriFromPosition(document, position)

      if (_.isNil(file_uri)) {
         return null
      }

      const text_document = await vscode.workspace.openTextDocument(file_uri)

      return new vscode.Hover({
         language: 'sql',
         value: text_document.getText(),
      })
   }
}
