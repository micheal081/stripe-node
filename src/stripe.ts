import _Error = require('./Error');

const resources = require('./resources');

const DEFAULT_HOST = 'api.stripe.com';
const DEFAULT_PORT = '443';
const DEFAULT_BASE_PATH = '/v1/';
const DEFAULT_API_VERSION = null as string;

const DEFAULT_TIMEOUT = 80000;

Stripe.PACKAGE_VERSION = require('../package.json').version;

const utils = require('./utils');
const {determineProcessUserAgentProperties, emitWarning} = utils;

Stripe.USER_AGENT = {
  bindings_version: Stripe.PACKAGE_VERSION,
  lang: 'node',
  publisher: 'stripe',
  uname: null,
  typescript: false,
  ...determineProcessUserAgentProperties(),
};

/** @private */
Stripe._UNAME_CACHE = null as Promise<string>;

const MAX_NETWORK_RETRY_DELAY_SEC = 2;
const INITIAL_NETWORK_RETRY_DELAY_SEC = 0.5;

const APP_INFO_PROPERTIES = ['name', 'version', 'url', 'partner_id'];
const ALLOWED_CONFIG_PROPERTIES = [
  'apiVersion',
  'typescript',
  'maxNetworkRetries',
  'httpAgent',
  'httpClient',
  'timeout',
  'host',
  'port',
  'protocol',
  'telemetry',
  'appInfo',
  'stripeAccount',
];

const EventEmitter = require('events').EventEmitter;
import StripeResource = require('./StripeResource');
import * as http from 'http';
Stripe.StripeResource = StripeResource;
Stripe.resources = resources;

const {HttpClient, HttpClientResponse} = require('./net/HttpClient');
Stripe.HttpClient = HttpClient;
Stripe.HttpClientResponse = HttpClientResponse;

const CryptoProvider = require('./crypto/CryptoProvider');
Stripe.CryptoProvider = CryptoProvider;

function Stripe(this: StripeObject, key: string, config = {}): void {
  if (!(this instanceof Stripe)) {
    return new (Stripe as any)(key, config);
  }

  const props = this._getPropsFromConfig(config);

  Object.defineProperty(this, '_emitter', {
    value: new EventEmitter(),
    enumerable: false,
    configurable: false,
    writable: false,
  });

  this.VERSION = Stripe.PACKAGE_VERSION;

  this.on = this._emitter.on.bind(this._emitter);
  this.once = this._emitter.once.bind(this._emitter);
  this.off = this._emitter.removeListener.bind(this._emitter);

  if (
    props.protocol &&
    props.protocol !== 'https' &&
    (!props.host || /\.stripe\.com$/.test(props.host))
  ) {
    throw new Error(
      'The `https` protocol must be used when sending requests to `*.stripe.com`'
    );
  }

  const agent = props.httpAgent || null;

  this._api = {
    auth: null,
    host: props.host || DEFAULT_HOST,
    port: props.port || DEFAULT_PORT,
    protocol: props.protocol || 'https',
    basePath: DEFAULT_BASE_PATH,
    version: props.apiVersion || DEFAULT_API_VERSION,
    timeout: utils.validateInteger('timeout', props.timeout, DEFAULT_TIMEOUT),
    maxNetworkRetries: utils.validateInteger(
      'maxNetworkRetries',
      props.maxNetworkRetries,
      0
    ),
    agent: agent,
    httpClient: props.httpClient || Stripe.createNodeHttpClient(agent),
    dev: false,
    stripeAccount: props.stripeAccount || null,
  };

  const typescript = props.typescript || false;
  if (typescript !== Stripe.USER_AGENT.typescript) {
    // The mutation here is uncomfortable, but likely fastest;
    // serializing the user agent involves shelling out to the system,
    // and given some users may instantiate the library many times without switching between TS and non-TS,
    // we only want to incur the performance hit when that actually happens.
    Stripe.USER_AGENT.typescript = typescript;
  }

  if (props.appInfo) {
    this._setAppInfo(props.appInfo);
  }

  this._prepResources();
  this._setApiKey(key);

  this.errors = _Error;
  this.webhooks = require('./Webhooks');

  this._prevRequestMetrics = [];
  this._enableTelemetry = props.telemetry !== false;

  // Expose StripeResource on the instance too
  this.StripeResource = Stripe.StripeResource;
}

Stripe.errors = _Error;
Stripe.webhooks = require('./Webhooks');

Stripe.createNodeHttpClient = (agent: http.Agent): typeof HttpClient => {
  const {NodeHttpClient} = require('./net/NodeHttpClient');
  return new NodeHttpClient(agent);
};

/**
 * Creates an HTTP client for issuing Stripe API requests which uses the Web
 * Fetch API.
 *
 * A fetch function can optionally be passed in as a parameter. If none is
 * passed, will default to the default `fetch` function in the global scope.
 */
Stripe.createFetchHttpClient = (fetchFn: typeof fetch): typeof HttpClient => {
  const {FetchHttpClient} = require('./net/FetchHttpClient');
  return new FetchHttpClient(fetchFn);
};

/**
 * Create a CryptoProvider which uses the built-in Node crypto libraries for
 * its crypto operations.
 */
Stripe.createNodeCryptoProvider = (): StripeCryptoProvider => {
  const NodeCryptoProvider = require('./crypto/NodeCryptoProvider');
  return new NodeCryptoProvider();
};

/**
 * Creates a CryptoProvider which uses the Subtle Crypto API from the Web
 * Crypto API spec for its crypto operations.
 *
 * A SubtleCrypto interface can optionally be passed in as a parameter. If none
 * is passed, will default to the default `crypto.subtle` object in the global
 * scope.
 */
Stripe.createSubtleCryptoProvider = (
  subtleCrypto: typeof crypto.subtle
): StripeCryptoProvider => {
  const SubtleCryptoProvider = require('./crypto/SubtleCryptoProvider');
  return new SubtleCryptoProvider(subtleCrypto);
};

Stripe.prototype = {
  /**
   * @deprecated will be removed in a future major version. Use the config object instead:
   *
   * const stripe = new Stripe(API_KEY, {
   *   host: 'example.com',
   *   port: '8080',
   *   protocol: 'http',
   * });
   *
   */
  setHost(host: string, port: number, protocol: string): void {
    emitWarning(
      '`setHost` is deprecated. Use the `host` config option instead.'
    );
    this._setApiField('host', host);
    if (port) {
      this.setPort(port);
    }
    if (protocol) {
      this.setProtocol(protocol);
    }
  },

  /**
   * @deprecated will be removed in a future major version. Use the config object instead:
   *
   * const stripe = new Stripe(API_KEY, {
   *   protocol: 'http',
   * });
   *
   */
  setProtocol(protocol: string): void {
    emitWarning(
      '`setProtocol` is deprecated. Use the `protocol` config option instead.'
    );
    this._setApiField('protocol', protocol.toLowerCase());
  },

  /**
   * @deprecated will be removed in a future major version. Use the config object instead:
   *
   * const stripe = new Stripe(API_KEY, {
   *   port: 3000,
   * });
   *
   */
  setPort(port: number): void {
    emitWarning(
      '`setPort` is deprecated. Use the `port` config option instead.'
    );
    this._setApiField('port', port);
  },

  /**
   * @deprecated will be removed in a future major version. Use the config object instead:
   *
   * const stripe = new Stripe(API_KEY, {
   *   apiVersion: API_VERSION,
   * });
   *
   */
  setApiVersion(version: string): void {
    emitWarning(
      '`setApiVersion` is deprecated. Use the `apiVersion` config or request option instead.'
    );
    if (version) {
      this._setApiField('version', version);
    }
  },

  /**
   * @deprecated will be removed in a future major version. Use the config object instead:
   *
   * const stripe = new Stripe(API_KEY);
   *
   * Or, for Stripe Connect, use `stripeAccount` instead:
   *
   * const stripe = new Stripe(API_KEY, {
   *   stripeAccount: 'acct_...',
   * });
   *
   * Or, to use a different apiKey on a given request:
   *
   * stripe.customers.create(params, {apiKey: 'sk_test_...'});
   */
  setApiKey(key: string): void {
    emitWarning(
      '`setApiKey` is deprecated. Use the `apiKey` request option instead.'
    );
    this._setApiKey(key);
  },

  /**
   * @private
   */
  _setApiKey(key: string): void {
    if (key) {
      this._setApiField('auth', `Bearer ${key}`);
    }
  },

  /**
   * @deprecated will be removed in a future major version. Use the config object instead:
   *
   * const stripe = new Stripe(API_KEY, {
   *   timeout: TIMEOUT_MS,
   * });
   */
  setTimeout(timeout: number): void {
    emitWarning(
      '`setTimeout` is deprecated. Use the `timeout` config or request option instead.'
    );
    this._setApiField('timeout', timeout == null ? DEFAULT_TIMEOUT : timeout);
  },

  /**
   * @deprecated will be removed in a future major version. Use the config object instead:
   *
   * const stripe = new Stripe(API_KEY, {
   *   appInfo: {
   *     name: 'MyPlugin',
   *     version: '1.4.2',
   *     url: 'https://myplugin.com',
   *     partner_id: '1234',
   *   },
   * });
   */
  setAppInfo(info: AppInfo): void {
    emitWarning(
      '`setAppInfo` is deprecated. Use the `appInfo` config option instead.'
    );
    this._setAppInfo(info);
  },

  /**
   * @private
   * This may be removed in the future.
   */
  _setAppInfo(info: AppInfo): void {
    if (info && typeof info !== 'object') {
      throw new Error('AppInfo must be an object.');
    }

    if (info && !info.name) {
      throw new Error('AppInfo.name is required');
    }

    info = info || {};

    this._appInfo = APP_INFO_PROPERTIES.reduce(
      (accum: Record<string, any>, prop) => {
        if (typeof info[prop] == 'string') {
          accum = accum || {};

          accum[prop] = info[prop];
        }

        return accum;
      },
      undefined
    );
  },

  /**
   * @deprecated will be removed in a future major version. Use the config object instead:
   *
   * const ProxyAgent = require('https-proxy-agent');
   * const stripe = new Stripe(API_KEY, {
   *   httpAgent: new ProxyAgent(process.env.http_proxy),
   * });
   *
   */
  setHttpAgent(agent: string): void {
    emitWarning(
      '`setHttpAgent` is deprecated. Use the `httpAgent` config option instead.'
    );
    this._setApiField('agent', agent);
  },

  /**
   * @private
   * This may be removed in the future.
   */
  _setApiField(key: string, value: unknown): void {
    this._api[key] = value;
  },

  /**
   * @private
   * Please open or upvote an issue at github.com/stripe/stripe-node
   * if you use this, detailing your use-case.
   *
   * It may be deprecated and removed in the future.
   */
  getApiField<T>(key: string): T {
    return this._api[key];
  },

  setClientId(clientId: string): void {
    this._clientId = clientId;
  },

  getClientId(): string {
    return this._clientId;
  },

  /**
   * @private
   * Please open or upvote an issue at github.com/stripe/stripe-node
   * if you use this, detailing your use-case.
   *
   * It may be deprecated and removed in the future.
   */
  getConstant: (c: string): unknown => {
    switch (c) {
      case 'DEFAULT_HOST':
        return DEFAULT_HOST;
      case 'DEFAULT_PORT':
        return DEFAULT_PORT;
      case 'DEFAULT_BASE_PATH':
        return DEFAULT_BASE_PATH;
      case 'DEFAULT_API_VERSION':
        return DEFAULT_API_VERSION;
      case 'DEFAULT_TIMEOUT':
        return DEFAULT_TIMEOUT;
      case 'MAX_NETWORK_RETRY_DELAY_SEC':
        return MAX_NETWORK_RETRY_DELAY_SEC;
      case 'INITIAL_NETWORK_RETRY_DELAY_SEC':
        return INITIAL_NETWORK_RETRY_DELAY_SEC;
    }
    return ((Stripe as unknown) as Record<string, unknown>)[c];
  },

  getMaxNetworkRetries(): number {
    return this.getApiField('maxNetworkRetries');
  },

  /**
   * @deprecated will be removed in a future major version. Use the config object instead:
   *
   * const stripe = new Stripe(API_KEY, {
   *   maxNetworkRetries: 2,
   * });
   *
   */
  setMaxNetworkRetries(maxNetworkRetries: number): void {
    this._setApiNumberField('maxNetworkRetries', maxNetworkRetries);
  },

  /**
   * @private
   * This may be removed in the future.
   */
  _setApiNumberField(prop: string, n: number, defaultVal?: number): void {
    const val = utils.validateInteger(prop, n, defaultVal);

    this._setApiField(prop, val);
  },

  getMaxNetworkRetryDelay(): number {
    return MAX_NETWORK_RETRY_DELAY_SEC;
  },

  getInitialNetworkRetryDelay(): number {
    return INITIAL_NETWORK_RETRY_DELAY_SEC;
  },

  /**
   * @private
   */
  getUname(cb: (uname: string) => void): void {
    if (!Stripe._UNAME_CACHE) {
      Stripe._UNAME_CACHE = new Promise<string>((resolve) => {
        utils.safeExec('uname -a', (err: Error, uname: string) => {
          resolve(uname);
        });
      });
    }
    Stripe._UNAME_CACHE.then((uname: string) => cb(uname));
  },

  /**
   * @private
   * Please open or upvote an issue at github.com/stripe/stripe-node
   * if you use this, detailing your use-case.
   *
   * It may be deprecated and removed in the future.
   *
   * Gets a JSON version of a User-Agent and uses a cached version for a slight
   * speed advantage.
   */
  getClientUserAgent(cb: (userAgent: string) => void): void {
    return this.getClientUserAgentSeeded(Stripe.USER_AGENT, cb);
  },

  /**
   * @private
   * Please open or upvote an issue at github.com/stripe/stripe-node
   * if you use this, detailing your use-case.
   *
   * It may be deprecated and removed in the future.
   *
   * Gets a JSON version of a User-Agent by encoding a seeded object and
   * fetching a uname from the system.
   */
  getClientUserAgentSeeded(
    seed: Record<string, string>,
    cb: (userAgent: string) => void
  ): void {
    this.getUname((uname: string) => {
      const userAgent: Record<string, string> = {};
      for (const field in seed) {
        userAgent[field] = encodeURIComponent(seed[field]);
      }

      // URI-encode in case there are unusual characters in the system's uname.
      userAgent.uname = encodeURIComponent(uname || 'UNKNOWN');

      const client = this.getApiField('httpClient');
      if (client) {
        userAgent.httplib = encodeURIComponent(client.getClientName());
      }

      if (this._appInfo) {
        userAgent.application = this._appInfo;
      }

      cb(JSON.stringify(userAgent));
    });
  },

  /**
   * @private
   * Please open or upvote an issue at github.com/stripe/stripe-node
   * if you use this, detailing your use-case.
   *
   * It may be deprecated and removed in the future.
   */
  getAppInfoAsString(): string {
    if (!this._appInfo) {
      return '';
    }

    let formatted = this._appInfo.name;

    if (this._appInfo.version) {
      formatted += `/${this._appInfo.version}`;
    }

    if (this._appInfo.url) {
      formatted += ` (${this._appInfo.url})`;
    }

    return formatted;
  },

  /**
   * @deprecated will be removed in a future major version. Use the config object instead:
   *
   * const stripe = new Stripe(API_KEY, {
   *   telemetry: false,
   * });
   *
   */
  setTelemetryEnabled(enableTelemetry: boolean): void {
    emitWarning(
      '`setTelemetryEnabled` is deprecated. Use the `telemetry` config option instead.'
    );
    this._enableTelemetry = enableTelemetry;
  },

  getTelemetryEnabled(): boolean {
    return this._enableTelemetry;
  },

  /**
   * @private
   * This may be removed in the future.
   */
  _prepResources(): void {
    for (const name in resources) {
      this[utils.pascalToCamelCase(name)] = new resources[name](this);
    }
  },

  /**
   * @private
   * This may be removed in the future.
   */
  _getPropsFromConfig(config: Record<string, unknown>): UserProvidedConfig {
    // If config is null or undefined, just bail early with no props
    if (!config) {
      return {};
    }

    // config can be an object or a string
    const isString = typeof config === 'string';
    const isObject = config === Object(config) && !Array.isArray(config);

    if (!isObject && !isString) {
      throw new Error('Config must either be an object or a string');
    }

    // If config is a string, we assume the old behavior of passing in a string representation of the api version
    if (isString) {
      return {
        apiVersion: config,
      };
    }

    // If config is an object, we assume the new behavior and make sure it doesn't contain any unexpected values
    const values = Object.keys(config).filter(
      (value) => !ALLOWED_CONFIG_PROPERTIES.includes(value)
    );

    if (values.length > 0) {
      throw new Error(
        `Config object may only contain the following: ${ALLOWED_CONFIG_PROPERTIES.join(
          ', '
        )}`
      );
    }

    return config;
  },
};

module.exports = Stripe;

// expose constructor as a named property to enable mocking with Sinon.JS
module.exports.Stripe = Stripe;

// Allow use with the TypeScript compiler without `esModuleInterop`.
// We may also want to add `Object.defineProperty(exports, "__esModule", {value: true});` in the future, so that Babel users will use the `default` version.
module.exports.default = Stripe;
