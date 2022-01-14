import { StartExecutionCommand, SFNClient } from '@aws-sdk/client-sfn';

const client = new SFNClient({});

export const handler = async (event: any = {}): Promise<any> => {
  console.log('Processing Event:');
  console.log(JSON.stringify(event));
  const body = JSON.parse(event['Records'][0]['body']);
  const message = JSON.parse(body['Message']);
  const document_location: any = message['DocumentLocation'];
  const bucket_name: string = document_location['S3Bucket'];
  const key: string = document_location['S3ObjectName'];

  const job_id = message['JobId'];
  const status = message['Status'];
  const job_name = key.split('/').join('-').split(':').join('_');
  const input = {
    bucket_name,
    key,
    job_name,
    job_id,
    status,
  };

  const command = new StartExecutionCommand({
    stateMachineArn: process.env['STATE_MACHINE_ARN'],
    input: JSON.stringify(input),
  });

  console.log('command:', command);
  const response = await client.send(command);
  return response['executionArn'];
};
