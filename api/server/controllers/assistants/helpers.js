const { EModelEndpoint, CacheKeys, defaultAssistantsVersion } = require('librechat-data-provider');
const {
  initializeClient: initAzureClient,
} = require('~/server/services/Endpoints/azureAssistants');
const { initializeClient } = require('~/server/services/Endpoints/assistants');
const { getLogStores } = require('~/cache');

/**
 * @param {Express.Request} req
 * @param {string} [endpoint]
 * @returns {Promise<string>}
 */
const getCurrentVersion = async (req, endpoint) => {
  const index = req.baseUrl.lastIndexOf('/v');
  let version = index !== -1 ? req.baseUrl.substring(index + 1, index + 3) : null;
  if (!version && req.body.version) {
    version = `v${req.body.version}`;
  }
  if (!version && endpoint) {
    const cache = getLogStores(CacheKeys.CONFIG_STORE);
    const cachedEndpointsConfig = await cache.get(CacheKeys.ENDPOINT_CONFIG);
    version = `v${
      cachedEndpointsConfig?.[endpoint]?.version ?? defaultAssistantsVersion[endpoint]
    }`;
  }
  if (!version?.startsWith('v') && version.length !== 2) {
    throw new Error(`[${req.baseUrl}] Invalid version: ${version}`);
  }
  return version;
};

/**
 * Asynchronously lists assistants based on provided query parameters.
 *
 * Initializes the client with the current request and response objects and lists assistants
 * according to the query parameters. This function abstracts the logic for non-Azure paths.
 *
 * @async
 * @param {object} params - The parameters object.
 * @param {object} params.req - The request object, used for initializing the client.
 * @param {object} params.res - The response object, used for initializing the client.
 * @param {string} params.version - The API version to use.
 * @param {object} params.query - The query parameters to list assistants (e.g., limit, order).
 * @returns {Promise<object>} A promise that resolves to the response from the `openai.beta.assistants.list` method call.
 */
const listAssistants = async ({ req, res, version, query }) => {
  const { openai } = await getOpenAIClient({ req, res, version });
  return openai.beta.assistants.list(query);
};

/**
 * Asynchronously lists assistants for Azure configured groups.
 *
 * Iterates through Azure configured assistant groups, initializes the client with the current request and response objects,
 * lists assistants based on the provided query parameters, and merges their data alongside the model information into a single array.
 *
 * @async
 * @param {object} params - The parameters object.
 * @param {object} params.req - The request object, used for initializing the client and manipulating the request body.
 * @param {object} params.res - The response object, used for initializing the client.
 * @param {string} params.version - The API version to use.
 * @param {TAzureConfig} params.azureConfig - The Azure configuration object containing assistantGroups and groupMap.
 * @param {object} params.query - The query parameters to list assistants (e.g., limit, order).
 * @returns {Promise<AssistantListResponse>} A promise that resolves to an array of assistant data merged with their respective model information.
 */
const listAssistantsForAzure = async ({ req, res, version, azureConfig = {}, query }) => {
  /** @type {Array<[string, TAzureModelConfig]>} */
  const groupModelTuples = [];
  const promises = [];
  /** @type {Array<TAzureGroup>} */
  const groups = [];

  const { groupMap, assistantGroups } = azureConfig;

  for (const groupName of assistantGroups) {
    const group = groupMap[groupName];
    groups.push(group);

    const currentModelTuples = Object.entries(group?.models);
    groupModelTuples.push(currentModelTuples);

    /* The specified model is only necessary to
    fetch assistants for the shared instance */
    req.body.model = currentModelTuples[0][0];
    promises.push(listAssistants({ req, res, version, query }));
  }

  const resolvedQueries = await Promise.all(promises);
  const data = resolvedQueries.flatMap((res, i) =>
    res.data.map((assistant) => {
      const deploymentName = assistant.model;
      const currentGroup = groups[i];
      const currentModelTuples = groupModelTuples[i];
      const firstModel = currentModelTuples[0][0];

      if (currentGroup.deploymentName === deploymentName) {
        return { ...assistant, model: firstModel };
      }

      for (const [model, modelConfig] of currentModelTuples) {
        if (modelConfig.deploymentName === deploymentName) {
          return { ...assistant, model };
        }
      }

      return { ...assistant, model: firstModel };
    }),
  );

  return {
    first_id: data[0]?.id,
    last_id: data[data.length - 1]?.id,
    object: 'list',
    has_more: false,
    data,
  };
};

async function getOpenAIClient({ req, res, endpointOption, initAppClient, overrideEndpoint }) {
  let endpoint = overrideEndpoint ?? req.body.endpoint ?? req.query.endpoint;
  const version = await getCurrentVersion(req, endpoint);
  if (!endpoint) {
    throw new Error(`[${req.baseUrl}] Endpoint is required`);
  }

  let result;
  if (endpoint === EModelEndpoint.assistants) {
    result = await initializeClient({ req, res, version, endpointOption, initAppClient });
  } else if (endpoint === EModelEndpoint.azureAssistants) {
    result = await initAzureClient({ req, res, version, endpointOption, initAppClient });
  }

  return result;
}

const fetchAssistants = async (req, res) => {
  const { limit = 100, order = 'desc', after, before, endpoint } = req.query;
  const version = await getCurrentVersion(req, endpoint);
  const query = { limit, order, after, before };

  /** @type {AssistantListResponse} */
  let body;

  if (endpoint === EModelEndpoint.assistants) {
    ({ body } = await listAssistants({ req, res, version, query }));
  } else if (endpoint === EModelEndpoint.azureAssistants) {
    const azureConfig = req.app.locals[EModelEndpoint.azureOpenAI];
    body = await listAssistantsForAzure({ req, res, version, azureConfig, query });
  }

  return body;
};

module.exports = {
  getOpenAIClient,
  fetchAssistants,
  getCurrentVersion,
};
