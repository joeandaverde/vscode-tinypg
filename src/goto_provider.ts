import * as vscode from 'vscode'
import * as _ from 'lodash'
import { getTinyFileUriFromPosition } from './util'

export class TinyGoToProvider implements vscode.DefinitionProvider {
   public async provideDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location | null> {
      const file_uri = await getTinyFileUriFromPosition(document, position)

      if (_.isNil(file_uri)) {
         return null
      }

      return new vscode.Location(file_uri, new vscode.Position(0, 0))
   }
}
