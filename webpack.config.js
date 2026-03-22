const path = require("path");
const webpack = require("webpack");

module.exports = {
  mode: "production",
  devtool: "cheap-module-source-map",

  entry: {
    background: "./src/background/service-worker.js",
    content: "./src/content/content.js",
    sidebar: "./src/sidebar/sidebar.js",
  },

  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].js",
    clean: true,
  },

  resolve: {
    extensions: [".js", ".ts", ".json"],
    fallback: {
      // Node.js polyfills for WDK
      buffer: require.resolve("buffer/"),
      crypto: require.resolve("crypto-browserify"),
      stream: require.resolve("stream-browserify"),
      assert: require.resolve("assert/"),
      http: require.resolve("stream-http"),
      https: require.resolve("https-browserify"),
      os: require.resolve("os-browserify/browser"),
      url: require.resolve("url/"),
      util: require.resolve("util/"),
      events: require.resolve("events/"),
      path: require.resolve("path-browserify"),
      process: require.resolve("process/browser"),
      string_decoder: require.resolve("string_decoder/"),
      vm: require.resolve("vm-browserify"),
      // Not needed — disable completely
      fs: false,
      net: false,
      tls: false,
      child_process: false,
      dns: false,
      dgram: false,
      readline: false,
      worker_threads: false,
    },
    alias: {
      // Critical: replace native C++ sodium with pure JS implementation
      "sodium-native": require.resolve("sodium-javascript"),
      "sodium-universal": require.resolve("sodium-javascript"),
      // Alias require-addon to empty module (native addon loader not needed)
      "require-addon": false,
    },
  },

  plugins: [
    new webpack.ProvidePlugin({
      process: "process/browser",
      Buffer: ["buffer", "Buffer"],
    }),
    new webpack.DefinePlugin({
      "process.env.NODE_DEBUG": JSON.stringify(""),
    }),
    // Ignore optional native modules that WDK tries to load
    new webpack.IgnorePlugin({
      resourceRegExp: /^(require-addon|node-gyp-build)$/,
    }),
  ],

  module: {
    rules: [
      {
        test: /\.m?js$/,
        resolve: {
          fullySpecified: false,
        },
      },
    ],
    // Suppress warnings from sodium-native trying to load native bindings
    noParse: /sodium-native/,
  },

  // Service worker needs to be self-contained
  optimization: {
    minimize: true,
  },

  // Ignore warnings about critical dependencies in native modules
  ignoreWarnings: [
    { module: /sodium-native/ },
    { module: /require-addon/ },
  ],
};