import * as vscode from 'vscode'
import * as _ from 'lodash'
import * as ts from 'typescript'
import { parseSql, SqlParseResult } from 'tinypg-parser'
import { TinyCallSearchResult, UserParams } from './types'

export const SqlCallRegex = /\.sql[^(]*\(\s*['"\`]([^'"\`]+)['"\`]/

export const QueryCallRegex = /query[^(]*\(['"\`]/

async function findTinySqlFile(sql_file_key: string): Promise<vscode.Uri | null> {
   const path_to_search = `**/${sql_file_key.replace('.', '/')}.sql`

   const file_uris = await vscode.workspace.findFiles(path_to_search, '**/node_modules/**')

   if (file_uris.length === 0) {
      return null
   }

   return file_uris[0]
}

function findAllTinyCallsHelp(call_name: string, results: ts.CallExpression[], n: ts.Node) {
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

   ts.forEachChild(n, child => findAllTinyCallsHelp(call_name, results, child))
}

export function findAllTinyCalls(call_name: string, n: ts.Node): ts.CallExpression[] {
   const matching_expressions: ts.CallExpression[] = []
   findAllTinyCallsHelp(call_name, matching_expressions, n)
   return matching_expressions
}

export function collectUserParams(document: vscode.TextDocument, object_literal_exp: ts.ObjectLiteralExpression): UserParams {
   const assigned_object_properties = <ts.PropertyAssignment[]>(
      object_literal_exp.properties.filter(x => x.kind === ts.SyntaxKind.PropertyAssignment || x.kind === ts.SyntaxKind.ShorthandPropertyAssignment)
   )

   const property_names = assigned_object_properties.map(x => x.name.getText())

   const start_position = document.positionAt(object_literal_exp.pos)

   const end_position = document.positionAt(object_literal_exp.end)

   const all_property_assignment = property_names.length === object_literal_exp.properties.length

   return {
      property_names,
      range: new vscode.Range(start_position, end_position),
      all_property_assignment,
   }
}

export function checkForExtraProperties(parse_result: SqlParseResult | null, user_params: UserParams | null) {
   if (_.isNil(user_params) || _.isNil(parse_result)) {
      return
   }

   const param_keys = _.keyBy(parse_result.mapping.map(x => x.name))

   return {
      user_parameters: user_params,
      extra_properties: user_params.property_names.filter(p => {
         return _.isNil(param_keys[p])
      }),
   }
}

export function checkForMissingProperties(parse_result: SqlParseResult | null, user_params: UserParams | null) {
   if (_.isNil(user_params) || _.isNil(parse_result)) {
      return
   }

   const property_name_lookup = _.keyBy(user_params.property_names)
   const required_properties = parse_result.mapping.map(x => x.name)

   return {
      user_parameters: user_params,
      missing_properties: required_properties.filter(p => _.isNil(property_name_lookup[p])),
   }
}

export async function getTinyFileUriFromPosition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Uri | null> {
   const line = document.lineAt(position).text
   const matches = SqlCallRegex.exec(line)

   if (!matches || !position.isAfterOrEqual(new vscode.Position(position.line, matches.index))) {
      return null
   }

   return await findTinySqlFile(matches[1])
}

export async function collectTinyCallDetails(document: vscode.TextDocument): Promise<TinyCallSearchResult[]> {
   const source_file = ts.createSourceFile(document.fileName, document.getText(), ts.ScriptTarget.ES2016, true)

   if (!source_file) {
      return []
   }

   const found_calls = findAllTinyCalls('sql', source_file)

   return _.compact(
      await Promise.all(
         found_calls.map(
            async (call_expression): Promise<TinyCallSearchResult | null> => {
               if (call_expression.arguments.length < 2) {
                  return null
               }

               const sql_call_key = (<ts.StringLiteralLike>call_expression.arguments[0]).text
               const sql_call_range = new vscode.Range(
                  document.positionAt(call_expression.arguments[0].pos),
                  document.positionAt(call_expression.arguments[0].end)
               )

               const getObjectLiteralProperties = () => {
                  if (call_expression.arguments[1].kind !== ts.SyntaxKind.ObjectLiteralExpression) {
                     return null
                  }

                  return collectUserParams(document, <ts.ObjectLiteralExpression>call_expression.arguments[1])
               }

               const getSqlFile = async () => {
                  const tiny_file = await findTinySqlFile(sql_call_key)

                  if (_.isNil(tiny_file)) {
                     return {
                        uri: null,
                        parse_result: null,
                     }
                  }

                  const tiny_file_contents = await vscode.workspace.openTextDocument(tiny_file)

                  const parse_result = parseSql(tiny_file_contents.getText())

                  return {
                     uri: tiny_file,
                     parse_result: parse_result,
                  }
               }

               const object_literal_details = getObjectLiteralProperties()

               return {
                  sql_call_key: sql_call_key,
                  sql_call_range: sql_call_range,
                  sql_file: await getSqlFile(),
                  user_parameters: object_literal_details,
               }
            }
         )
      )
   )
}
