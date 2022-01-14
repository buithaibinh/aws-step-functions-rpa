import { ProxyHandler } from './types';
import {
  TextractClient,
  StartDocumentAnalysisCommand,
  FeatureType,
} from '@aws-sdk/client-textract';

// a client can be shared by different commands.
const client = new TextractClient({
  // region: 'us-east-1',
});

export const handler: ProxyHandler = async (event: any = {}) => {
  console.log('Processing Event:');
  console.log(JSON.stringify(event, null, 2));
  const s3 = event['Records'][0]['s3'];
  const bucketName = s3['bucket']['name'];
  const key = s3['object']['key'];
  const documentLocation = {
    S3Object: {
      Bucket: bucketName,
      Name: key,
    },
  };

  const command = new StartDocumentAnalysisCommand({
    DocumentLocation: documentLocation,
    FeatureTypes: [FeatureType.TABLES, FeatureType.FORMS],
    NotificationChannel: {
      SNSTopicArn: process.env['DOCUMENT_ANALYIS_COMPLETED_SNS_TOPIC_ARN'],
      RoleArn: process.env['TEXTRACT_PUBLISH_TO_SNS_ROLE_ARN'],
    },
  });

  const response = await client.send(command);
  console.log('data:', response);
  event['job_id'] = response['JobId'];
  return event;
};
