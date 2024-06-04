import { ProposedFeatures, createConnection } from 'vscode-languageserver/node';


// Creates the LSP connection
export const connection = createConnection(ProposedFeatures.all)