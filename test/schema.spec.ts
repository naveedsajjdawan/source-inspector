import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import Ajv, { type AnySchemaObject } from 'ajv';
import addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const ignoredDirectories = new Set(['.git', 'dist', 'node_modules']);
const supportedExtensions = new Set(['.json', '.yaml', '.yml']);

async function sourceFiles(directory: string): Promise<string[]> {
    const files: string[] = [];

    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;

        const entryPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            files.push(...(await sourceFiles(entryPath)));
        } else if (entry.isFile() && supportedExtensions.has(path.extname(entry.name))) {
            files.push(entryPath);
        }
    }

    return files;
}

async function readDocument(file: string): Promise<unknown> {
    const contents = await fs.readFile(file, 'utf8');
    return path.extname(file) === '.json' ? JSON.parse(contents) : parseYaml(contents);
}

async function declaresSchema(file: string): Promise<boolean> {
    const contents = await fs.readFile(file, 'utf8');
    return path.extname(file) === '.json'
        ? /\"\$schema\"\s*:/.test(contents)
        : /^\s*\$schema\s*:/m.test(contents);
}

function schemaReference(document: unknown): string | undefined {
    if (typeof document !== 'object' || document === null || Array.isArray(document)) return;

    const reference = (document as Record<string, unknown>).$schema;
    return typeof reference === 'string' ? reference : undefined;
}

async function loadSchema(uri: string): Promise<AnySchemaObject> {
    if (uri.startsWith('file:')) {
        return readDocument(fileURLToPath(uri)) as Promise<AnySchemaObject>;
    }

    const response = await fetch(uri);
    assert.ok(response.ok, `Unable to load schema ${uri}: ${response.status} ${response.statusText}`);
    return response.json() as Promise<AnySchemaObject>;
}

describe('schema-backed source files', async () => {
    const documents = [];

    for (const file of await sourceFiles(projectRoot)) {
        if (!(await declaresSchema(file))) continue;

        const document = await readDocument(file);
        const reference = schemaReference(document);

        if (reference) documents.push({ document, file, reference });
    }

    await it('exist', () => {
        assert.notEqual(documents.length, 0, 'No source files with a top-level $schema were found');
    });

    for (const { document, file, reference } of documents) {
        it(path.relative(projectRoot, file), async () => {
            const schemaUri = new URL(reference, pathToFileURL(file)).href;
            // SchemaStore currently contains some cross-branch `required` keywords and
            // vendor extensions such as `allowTrailingCommas`. Keep data validation
            // strict while accepting those schema-authoring extensions.
            const ajv = new Ajv({ allErrors: true, loadSchema, strict: true, strictRequired: false, strictSchema: false });
            addFormats(ajv);

            const validate = ajv.getSchema(schemaUri) ?? (await ajv.compileAsync(await loadSchema(schemaUri)));
            assert.ok(
                validate(document),
                `${path.relative(projectRoot, file)} does not match ${reference}:\n${ajv.errorsText(validate.errors, { separator: '\n' })}`
            );
        });
    }
});
