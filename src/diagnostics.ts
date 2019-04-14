import * as ts from 'typescript'
import * as vscode from 'vscode'
import * as _ from 'lodash'
import {
   SqlCallRegex,
   QueryCallRegex,
   checkForExtraProperties,
   checkForMissingProperties,
   collectTinyCallDetails,
   collectUserParams,
   findAllTinyCalls,
} from './util'
import { UserParams, QueryCallSearchResult } from './types'
import { parseSql } from 'tinypg-parser'

const query_diagnostics = vscode.languages.createDiagnosticCollection('tinypg-query')
const sql_diagnostics = vscode.languages.createDiagnosticCollection('tinypg-sql')

export async function missingSqlFileDiagnostics(document: vscode.TextDocument) {
   if (document.languageId !== 'typescript' && !SqlCallRegex.test(document.getText())) {
      return
   }

   sql_diagnostics.set(document.uri, await checkForSqlBindings(document))
}

export async function runQueryDiagnostics(document: vscode.TextDocument) {
   if (document.languageId !== 'typescript' && !QueryCallRegex.test(document.getText())) {
      return
   }

   query_diagnostics.set(document.uri, await checkQueryBindings(document))
}

export async function runDiagnostics(document: vscode.TextDocument) {
   await Promise.all([missingSqlFileDiagnostics(document), runQueryDiagnostics(document)])
}

export async function checkQueryBindings(document: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
   const source_file = ts.createSourceFile(document.fileName, document.getText(), ts.ScriptTarget.ES2016, true)

   if (!source_file) {
      return []
   }

   const found_query_calls = findAllTinyCalls('query', source_file)

   const tiny_queries: QueryCallSearchResult[] = _.compact(
      await Promise.all(
         found_query_calls.map(async call_expression => {
            if (call_expression.arguments.length < 2) {
               return null
            }

            const query_text = (<ts.StringLiteral>call_expression.arguments[0]).text

            const getUserParams = () => {
               const object_literal_exp = <ts.ObjectLiteralExpression>call_expression.arguments[1]
               return collectUserParams(document, <ts.ObjectLiteralExpression>object_literal_exp)
            }

            const parseQuery = async () => {
               const parse_result = parseSql(query_text)

               return {
                  parse_result: parse_result,
               }
            }

            return {
               query: await parseQuery(),
               user_parameters: getUserParams(),
            }
         })
      )
   )

   const extra_property_diagnostics = _.flatMap(tiny_queries, tiny_query => {
      const check = checkForExtraProperties(tiny_query.query.parse_result, tiny_query.user_parameters)

      return _.isNil(check) ? [] : extraPropertyDiagnostics(check.user_parameters, check.extra_properties, `sql query`)
   })

   const missing_property_diagnostics = _.flatMap(tiny_queries, tiny_query => {
      const check = checkForMissingProperties(tiny_query.query.parse_result, tiny_query.user_parameters)

      return _.isNil(check) ? [] : missingPropertyDiagnostics(check.user_parameters, check.missing_properties, `sql query`)
   })

   return missing_property_diagnostics.concat(extra_property_diagnostics)
}

export async function checkForSqlBindings(document: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
   const tiny_calls = await collectTinyCallDetails(document)

   const extra_property_diagnostics = _.flatMap(tiny_calls, tiny_call => {
      const check = checkForExtraProperties(tiny_call.sql_file.parse_result, tiny_call.user_parameters)

      return _.isNil(check) ? [] : extraPropertyDiagnostics(check.user_parameters, check.extra_properties, tiny_call.sql_call_key)
   })

   const missing_property_diagnostics = _.flatMap(tiny_calls, tiny_call => {
      const check = checkForMissingProperties(tiny_call.sql_file.parse_result, tiny_call.user_parameters)

      return _.isNil(check) ? [] : missingPropertyDiagnostics(check.user_parameters, check.missing_properties, tiny_call.sql_call_key)
   })

   const missing_files = tiny_calls
      .filter(x => _.isNil(x.sql_file.uri))
      .map(x => ({ range: x.sql_call_range, key: x.sql_call_key, file: x.sql_file }))

   const file_groups = _.groupBy(missing_files, x => x.key)

   const missing_file_diagnostics = _.flatMap(file_groups, (missing, key) => {
      return missing.map(m => {
         return new vscode.Diagnostic(m.range, `TinyPg: SQL file [${key}] not found.`, vscode.DiagnosticSeverity.Error)
      })
   })

   return _.concat(missing_property_diagnostics, extra_property_diagnostics, missing_file_diagnostics)
}

function extraPropertyDiagnostics(user_params: UserParams, extra_properties: string[], name: string): vscode.Diagnostic[] {
   if (_.isEmpty(extra_properties)) {
      return []
   }

   return [
      new vscode.Diagnostic(
         user_params.range,
         `TinyPg: Unused ${extra_properties.length === 1 ? 'parameter' : 'parameters'} [${extra_properties.join(', ')}] for [${name}].`,
         vscode.DiagnosticSeverity.Warning
      ),
   ]
}

function missingPropertyDiagnostics(user_params: UserParams, missing_properties: string[], name: string): vscode.Diagnostic[] {
   if (_.isEmpty(missing_properties)) {
      return []
   }

   return [
      new vscode.Diagnostic(
         user_params.range,
         `TinyPg: Missing ${missing_properties.length === 1 ? 'parameter' : 'parameters'} [${missing_properties.join(', ')}] for [${name}].`,
         vscode.DiagnosticSeverity.Error
      ),
   ]
}
