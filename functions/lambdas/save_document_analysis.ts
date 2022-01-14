import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  TextractClient,
  GetDocumentAnalysisCommand,
} from '@aws-sdk/client-textract';

const texttract_client = new TextractClient({});
const s3_client = new S3Client({});

const getTextDocumentAnalysis = async (jobId: string, nextToken?: string) => {
  const getDocumentAnalysisCommand = new GetDocumentAnalysisCommand({
    JobId: jobId,
    NextToken: nextToken,
  });
  const data = await texttract_client.send(getDocumentAnalysisCommand);
  console.log(data);
  return data;
};

const saveResultToS3 = async ({
  bucket,
  key,
  data,
}: {
  bucket: string;
  key: string;
  data: string;
}) => {
  // put object command
  const putObjectCommand = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: data,
  });
  await s3_client.send(putObjectCommand);
};

export const handler = async (event: any = {}): Promise<any> => {
  console.log('Processing Event:');
  console.log(JSON.stringify(event));

  let response = await getTextDocumentAnalysis(event['job_id']);
  const analysis = { ...response };
  let blocks: any[] = [];
  while (true) {
    blocks = [...blocks, ...(response['Blocks'] || [])];
    const nextToken = response['NextToken'];
    if (nextToken) {
      response = await getTextDocumentAnalysis(event['job_id'], nextToken);
    } else {
      break;
    }
  }

  // synth response
  delete analysis['NextToken'];
  analysis['Blocks'] = blocks;

  // save result to s3
  const invoice_analyses_bucket_name = process.env.ANALYSES_BUCKET_NAME!;
  const invoice_analyses_bucket_key = `scanned-invoices/${event['key']}.json`;
  await saveResultToS3({
    bucket: invoice_analyses_bucket_name,
    key: invoice_analyses_bucket_key,
    data: JSON.stringify(analysis),
  });

  event['invoice_analyses_bucket_name'] = invoice_analyses_bucket_name;
  event['invoice_analyses_bucket_key'] = invoice_analyses_bucket_key;
  return event;
};
