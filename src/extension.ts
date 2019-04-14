import * as vscode from 'vscode'
import * as _ from 'lodash'
import { TinyHoverProvider } from './hover_provider'
import { TinyGoToProvider } from './goto_provider'
import { runDiagnostics } from './diagnostics'

const TS_MODE: vscode.DocumentFilter = { language: 'typescript', scheme: 'file' }

export async function activate(ctx: vscode.ExtensionContext) {
   ctx.subscriptions.push(vscode.languages.registerHoverProvider(TS_MODE, new TinyHoverProvider()))
   ctx.subscriptions.push(vscode.languages.registerDefinitionProvider(TS_MODE, new TinyGoToProvider()))

   vscode.workspace.onDidOpenTextDocument(runDiagnostics)
   vscode.workspace.onDidSaveTextDocument(runDiagnostics)
   vscode.workspace.onDidOpenTextDocument(runDiagnostics)
}
