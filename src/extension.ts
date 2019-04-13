'use strict'
import * as vscode from 'vscode'
import * as _ from 'lodash'
import * as ts from 'typescript'
import { parseSql, SqlParseResult } from 'tinypg-parser'

const TS_MODE: vscode.DocumentFilter = { language: 'typescript', scheme: 'file' }

const SqlCallRegex = /\.sql[^(]*\(\s*['"\`]([^'"\`]+)['"\`]/
const QueryCallRegex = /\.query[^(]*\(['"\`]/

async function getTinyFileUriFromPosition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Uri> {
   const line = document.lineAt(position).text
   const matches = SqlCallRegex.exec(line)

   if (!matches || !position.isAfterOrEqual(new vscode.Position(position.line, matches.index))) {
      return null
   }

   return await findTinySqlFile(matches[1])
}

export async function findTinySqlFile(sql_file_key: string): Promise<vscode.Uri> {
   const path_to_search = `**/${sql_file_key.replace('.', '/')}.sql`

   const file_uris = await vscode.workspace.findFiles(path_to_search, '**/node_modules/**')

   if (file_uris.length === 0) {
      return null
   }

   return file_uris[0]
}

interface TinyCallSearchResult {
   parsed_sql_file: SqlParseResult
   property_names: string[]
   all_property_assignment: boolean
   sql_call_key: string
   start_position: vscode.Position
   end_position: vscode.Position
}

interface QueryCallSearchResult {
   parsed_sql_expression: SqlParseResult
   property_names: string[]
   all_property_assignment: boolean
   start_position: vscode.Position
   end_position: vscode.Position
}

const findAllTinyCalls = (call_name: string, results: ts.CallExpression[], n: ts.Node) => {
   if (n.kind === ts.SyntaxKind.CallExpression) {
      const call_expression = <ts.CallExpression>n
      const property_expression = <ts.PropertyAccessExpression>call_expression.expression

      if (property_expression && property_expression.name) {
         const property_name = property_expression.name.text

         if (property_name === call_name) {
            if (
               call_expression.arguments[0].kind === ts.SyntaxKind.StringLiteral ||
               call_expression.arguments[0].kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
            ) {
               results.push(call_expression)
            }
         }
      }
   }

   ts.forEachChild(n, child => findAllTinyCalls(call_name, results, child))
}

export async function checkForSqlBindings(document: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
   const source_file = ts.createSourceFile(document.fileName, document.getText(), ts.ScriptTarget.ES2016, true)

   if (!source_file) {
      return []
   }

   const found_sql_calls: ts.CallExpression[] = []

   findAllTinyCalls('sql', found_sql_calls, source_file)

   let results: TinyCallSearchResult[] = await Promise.all(
      found_sql_calls.map(async call_expression => {
         if (call_expression.arguments.length < 2) {
            return null
         }

         const sql_call_key = (<ts.StringLiteral>call_expression.arguments[0]).text

         const tiny_file = await findTinySqlFile(sql_call_key)

         if (!tiny_file || call_expression.arguments[1].kind !== ts.SyntaxKind.ObjectLiteralExpression) {
            return null
         }

         const object_literal_exp = <ts.ObjectLiteralExpression>call_expression.arguments[1]

         const assigned_object_properties = <ts.PropertyAssignment[]>(
            object_literal_exp.properties.filter(
               x => x.kind === ts.SyntaxKind.PropertyAssignment || x.kind === ts.SyntaxKind.ShorthandPropertyAssignment
            )
         )

         const property_names = assigned_object_properties.map(x => x.name.getText())

         const start_position = document.positionAt(object_literal_exp.pos)

         const end_position = document.positionAt(object_literal_exp.end)

         const tiny_file_contents = await vscode.workspace.openTextDocument(tiny_file)

         const parsed_sql_file = parseSql(tiny_file_contents.getText())

         return {
            start_position,
            end_position,
            parsed_sql_file,
            sql_call_key,
            property_names,
            all_property_assignment: property_names.length === object_literal_exp.properties.length,
         }
      })
   )

   const checkForExtraProperties = (x: TinyCallSearchResult) => {
      return {
         tiny_call: x,
         extra_properties: x.property_names.filter(p => {
            return !x.parsed_sql_file.mapping.some(x => x.name === p)
         }),
      }
   }

   const checkForMissingProperties = (x: TinyCallSearchResult) => {
      return {
         tiny_call: x,
         missing_properties: x.parsed_sql_file.mapping
            .filter(p => {
               return !x.property_names.some(n => p.name === n)
            })
            .map(p => p.name),
      }
   }

   results = results.filter(x => x)
   const full_verify = results.filter(x => x.all_property_assignment)

   const full_verify_results = full_verify.map(checkForMissingProperties)
   const partial_verify_results = results.map(checkForExtraProperties)

   const diagnostic_results = []
      .concat(
         full_verify_results
            .filter(x => !_.isEmpty(x.missing_properties))
            .map(x => {
               const range = new vscode.Range(x.tiny_call.start_position, x.tiny_call.end_position)

               return new vscode.Diagnostic(
                  range,
                  `Missing expected properties [${x.missing_properties.join(', ')}].`,
                  vscode.DiagnosticSeverity.Error
               )
            })
      )
      .concat(
         partial_verify_results
            .filter(x => !_.isEmpty(x.extra_properties))
            .map(x => {
               const range = new vscode.Range(x.tiny_call.start_position, x.tiny_call.end_position)

               return new vscode.Diagnostic(
                  range,
                  `Properties [${x.extra_properties.join(', ')}] do not exist in [${x.tiny_call.sql_call_key}].`,
                  vscode.DiagnosticSeverity.Warning
               )
            })
      )

   return diagnostic_results
}

export async function checkQueryBindings(document: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
   const source_file = ts.createSourceFile(document.fileName, document.getText(), ts.ScriptTarget.ES2016, true)

   if (!source_file) {
      return []
   }

   const found_query_calls: ts.CallExpression[] = []

   findAllTinyCalls('query', found_query_calls, source_file)

   let results: QueryCallSearchResult[] = await Promise.all(
      found_query_calls.map(async call_expression => {
         if (call_expression.arguments.length < 2) {
            return null
         }

         const query_text = (<ts.StringLiteral>call_expression.arguments[0]).text

         const object_literal_exp = <ts.ObjectLiteralExpression>call_expression.arguments[1]

         const assigned_object_properties = <ts.PropertyAssignment[]>(
            object_literal_exp.properties.filter(
               x => x.kind === ts.SyntaxKind.PropertyAssignment || x.kind === ts.SyntaxKind.ShorthandPropertyAssignment
            )
         )

         const property_names = assigned_object_properties.map(x => x.name.getText())

         const start_position = document.positionAt(object_literal_exp.pos)

         const end_position = document.positionAt(object_literal_exp.end)

         const parsed_sql_expression = parseSql(query_text)

         return {
            start_position,
            end_position,
            parsed_sql_expression,
            property_names,
            all_property_assignment: property_names.length === object_literal_exp.properties.length,
         }
      })
   )

   const checkForExtraProperties = (x: QueryCallSearchResult) => {
      return {
         query_call: x,
         extra_properties: x.property_names.filter(p => {
            return !x.parsed_sql_expression.mapping.some(x => x.name === p)
         }),
      }
   }

   const checkForMissingProperties = (x: QueryCallSearchResult) => {
      return {
         query_call: x,
         missing_properties: x.parsed_sql_expression.mapping
            .filter(p => {
               return !x.property_names.some(n => p.name === n)
            })
            .map(p => p.name),
      }
   }

   results = results.filter(x => x)
   const full_verify = results.filter(x => x.all_property_assignment)

   const full_verify_results = full_verify.map(checkForMissingProperties)
   const partial_verify_results = results.map(checkForExtraProperties)

   const diagnostic_results = []
      .concat(
         partial_verify_results
            .filter(x => !_.isEmpty(x.extra_properties))
            .map(x => {
               const range = new vscode.Range(x.query_call.start_position, x.query_call.end_position)

               return new vscode.Diagnostic(
                  range,
                  `Properties [${x.extra_properties.join(', ')}] do not exist in the supplied query.`,
                  vscode.DiagnosticSeverity.Warning
               )
            })
      )
      .concat(
         full_verify_results
            .filter(x => !_.isEmpty(x.missing_properties))
            .map(x => {
               const range = new vscode.Range(x.query_call.start_position, x.query_call.end_position)

               return new vscode.Diagnostic(
                  range,
                  `Missing expected properties [${x.missing_properties.join(', ')}].`,
                  vscode.DiagnosticSeverity.Error
               )
            })
      )

   return diagnostic_results
}

export class TinyHoverProvider implements vscode.HoverProvider {
   public async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover> {
      const file_uri = await getTinyFileUriFromPosition(document, position)

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
   public async provideDefinition(
      document: vscode.TextDocument,
      position: vscode.Position,
      token: vscode.CancellationToken
   ): Promise<vscode.Location> {
      const file_uri = await getTinyFileUriFromPosition(document, position)

      if (!file_uri) {
         return null
      }

      return new vscode.Location(file_uri, new vscode.Position(0, 0))
   }
}

export async function activate(ctx: vscode.ExtensionContext) {
   ctx.subscriptions.push(vscode.languages.registerHoverProvider(TS_MODE, new TinyHoverProvider()))
   ctx.subscriptions.push(vscode.languages.registerDefinitionProvider(TS_MODE, new TinyGoToProvider()))

   const invalid_tiny_file_parameters = vscode.languages.createDiagnosticCollection('tinypg-invalid-sql-params')
   const invalid_tiny_query_parameters = vscode.languages.createDiagnosticCollection('tinypg-invalid-query-params')
   const missing_tiny_files = vscode.languages.createDiagnosticCollection('tinypg-missing-files')

   vscode.workspace.onDidChangeTextDocument(
      async change_event => {
         const document = change_event.document

         if (document.languageId !== 'typescript') {
            return null
         }

         const tiny_sql_line_changes = change_event.contentChanges.filter(x => SqlCallRegex.test(document.lineAt(x.range.end).text))

         if (_.isEmpty(tiny_sql_line_changes)) {
            return
         }

         return await runFileDiagnostics(document, false)
      },
      this,
      ctx.subscriptions
   )

   vscode.workspace.onDidOpenTextDocument(
      async document => {
         await runFileDiagnostics(document, true)
         await runQueryDiagnostics(document)
         return
      },
      this,
      ctx.subscriptions
   )

   vscode.workspace.onDidSaveTextDocument(
      async document => {
         await runFileDiagnostics(document, true)
         await runQueryDiagnostics(document)
         return
      },
      this,
      ctx.subscriptions
   )

   async function runFileDiagnostics(document: vscode.TextDocument, check_params: boolean) {
      if (document.languageId !== 'typescript' && !SqlCallRegex.test(document.getText())) {
         return
      }

      if (check_params) {
         const invalid_parameter_diagnostics = await checkForSqlBindings(document)
         invalid_tiny_file_parameters.set(document.uri, invalid_parameter_diagnostics)
      }

      const missing_diagnostics = await missingTinyFiles(document)
      missing_tiny_files.set(document.uri, missing_diagnostics)
   }

   async function runQueryDiagnostics(document: vscode.TextDocument) {
      if (document.languageId !== 'typescript' && !QueryCallRegex.test(document.getText())) {
         return
      }

      const invalid_parameter_diagnostics = await checkQueryBindings(document)
      invalid_tiny_query_parameters.set(document.uri, invalid_parameter_diagnostics)
   }
}

async function missingTinyFiles(document: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
   const tiny_files = document
      .getText()
      .split('\n')
      .map((x, i) => {
         return {
            matches: SqlCallRegex.exec(x),
            line: i,
         }
      })
      .filter(x => x.matches)
      .map(x => {
         return {
            range: new vscode.Range(
               new vscode.Position(x.line, x.matches.index + 4),
               new vscode.Position(x.line, x.matches.index + x.matches[0].length)
            ),
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
