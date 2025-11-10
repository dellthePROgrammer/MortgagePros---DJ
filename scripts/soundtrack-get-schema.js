const fs = require('fs');
const path = require('path');

const {
  buildClientSchema,
  introspectionQuery,
  printSchema,
} = require('graphql/utilities');

async function fetchSchema() {
  const response = await fetch('https://api.soundtrackyourbrand.com/v2', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: introspectionQuery,
      operationName: 'IntrospectionQuery',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch schema: ${response.status} ${response.statusText}\n${text}`);
  }

  const payload = await response.json();

  if (payload.errors) {
    throw new Error(`GraphQL returned errors: ${JSON.stringify(payload.errors, null, 2)}`);
  }

  const schemaString = printSchema(buildClientSchema(payload.data));
  const targetPath = path.join(__dirname, 'soundtrack-schema.graphql');
  fs.writeFileSync(targetPath, schemaString);
  console.log(`Schema written to ${targetPath}`);
}

fetchSchema().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
