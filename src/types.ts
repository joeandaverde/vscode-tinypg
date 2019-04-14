import * as vscode from 'vscode'
import * as _ from 'lodash'
import { SqlParseResult } from 'tinypg-parser'

export interface UserParams {
   property_names: string[]
   all_property_assignment: boolean
   range: vscode.Range
}

export interface BaseSearchResult {
   user_parameters: UserParams | null
}

export interface TinyCallSearchResult extends BaseSearchResult {
   sql_call_key: string
   sql_call_range: vscode.Range
   sql_file: { parse_result: SqlParseResult | null; uri: vscode.Uri | null }
}

export interface QueryCallSearchResult extends BaseSearchResult {
   query: { parse_result: SqlParseResult }
}
