#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";
import { AwsDdbAppStateStack } from "../lib/app-state-stack";

const app = new cdk.App();
new AwsDdbAppStateStack(app, process.env.STACK_NAME!, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
