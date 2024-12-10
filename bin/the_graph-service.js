#!/usr/bin/env node

const cdk = require('aws-cdk-lib')
// const { BlockchainNodeStack } = require('../lib/blockchain-node-stack')
const { GraphNodeServiceStack } = require('../lib/the_graph-service-stack')
const { AwsSolutionsChecks } = require('cdk-nag')
const { getConfig } = require('../lib/config.js')

const app = new cdk.App()

const config = getConfig()

const {
  clientUrl,
  allowedIP,
  allowedSG,
  logLevel,
  chainId,
  apiKey,
  graphInstanceType,
  awsAccount,
  awsRegion,
} = config

// We don't deploy the AWS Ethereum Node
// const blockchainNodeStack = new BlockchainNodeStack(
//   app,
//   'BlockchainNodeStack',
//   {
//     env: {
//       account: awsAccount,
//       region: awsRegion,
//     },
//     blockchainInstanceType,
//     chainId,
//   }
// )

const GraphNodeServiceStackName = `graph-node-service-stack-${process.env.ENV}`

const graphStack = new GraphNodeServiceStack(app, GraphNodeServiceStackName, {
  env: {
    account: awsAccount,
    region: awsRegion,
  },
  logLevel,
  clientUrl,
  chainId,
  graphInstanceType,
  allowedIP,
  allowedSG,
  apiKey,
})

cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }))
