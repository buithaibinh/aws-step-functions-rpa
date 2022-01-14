import {
  Handler,
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

export type ProxyHandler = Handler<
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2
>;
