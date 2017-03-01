'use strict';
import * as vscode from 'vscode'
import * as _ from 'lodash'

const TS_MODE: vscode.DocumentFilter = { language: 'typescript', scheme: 'file' }

const SqlCallRegex = new RegExp(`sql\\(['"]([^'"]+)['"]`)

async function getTinyFileUri(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Uri> {
    const line = document.lineAt(position).text
    const matches = SqlCallRegex.exec(line)

    if (!matches || !position.isAfterOrEqual(new vscode.Position(position.line, matches.index))) {
        return null
    }

    const path_to_search = `**/${matches[1].replace('.', '/')}.sql`

    const file_uris = await vscode.workspace.findFiles(path_to_search, '**/node_modules/**')

    if (file_uris.length === 0) {
        return null
    }

    return file_uris[0]
}

export class TinyHoverProvider implements vscode.HoverProvider {
    public async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover> {
        const file_uri = await getTinyFileUri(document, position)

        if (!file_uri) {
            return null
        }

        const text_document = await vscode.workspace.openTextDocument(file_uri)

        return new vscode.Hover({
            language: 'sql',
            value: text_document.getText(),
        })
    }
}

export class TinyGoToProvider implements vscode.DefinitionProvider {
    public async provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Location> {
        const file_uri = await getTinyFileUri(document, position)

        if (!file_uri) {
            return null
        }

        return new vscode.Location(file_uri, new vscode.Position(0, 0))
    }
}

export async function activate(ctx: vscode.ExtensionContext) {
    ctx.subscriptions.push(vscode.languages.registerHoverProvider(TS_MODE, new TinyHoverProvider()))
    ctx.subscriptions.push(vscode.languages.registerDefinitionProvider(TS_MODE, new TinyGoToProvider()))

    const diagnosticCollection = vscode.languages.createDiagnosticCollection('tinypg')

    vscode.workspace.onDidChangeTextDocument(async change_event => {
        const document = change_event.document

        if (document.languageId !== 'typescript') {
            return null
        }

        const tiny_line_changes = change_event.contentChanges.filter(x => SqlCallRegex.test(document.lineAt(x.range.end).text))

        if (_.isEmpty(tiny_line_changes)) {
            return null
        }

        return await runDiagnostics(document)
    }, this, ctx.subscriptions)

    vscode.workspace.onDidOpenTextDocument(async document => {
        return await runDiagnostics(document)
    }, this, ctx.subscriptions)

    vscode.workspace.onDidSaveTextDocument(async document => {
        return await runDiagnostics(document)
    }, this, ctx.subscriptions)

    async function runDiagnostics(document: vscode.TextDocument) {
        const missing_diagnostics = await missingTinyFiles(document)
        diagnosticCollection.set(document.uri, missing_diagnostics)
    }
}

async function missingTinyFiles(document: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
    const tiny_files = document.getText().split('\n')
        .map((x, i) => { return {
            matches: SqlCallRegex.exec(x),
            line: i,
        }})
        .filter(x => x.matches)
        .map(x => {
            return {
                range: new vscode.Range(new vscode.Position(x.line, x.matches.index + 4), new vscode.Position(x.line, x.matches.index + x.matches[0].length)),
                file: `${x.matches[1].replace(/\./g, '/')}.sql`,
            }
        })

    const sql_files = await vscode.workspace.findFiles('**/*.sql', '**/node_modules/**')
    const sql_file_names = sql_files.map(x => x.path)
    const file_groups = _.groupBy(tiny_files, x => x.file)
    const tiny_file_names = _.keys(file_groups)
    const non_existent = _.filter(tiny_file_names, x => !_.some(sql_file_names, f => f.indexOf(x) >= 0))

    return _.flatMap(non_existent, n => {
        return file_groups[n].map(f => {
            return new vscode.Diagnostic(f.range, 'file dont exist', vscode.DiagnosticSeverity.Error)
        })
    })
}