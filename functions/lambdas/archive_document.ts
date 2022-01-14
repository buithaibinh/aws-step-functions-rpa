import { ProxyHandler } from './types';

import {
  S3Client,
  CopyObjectCommand,
  CopyObjectCommandInput,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
const s3_client = new S3Client({});

export const handler: ProxyHandler = async (event: any = {}) => {
  console.log('Processing Event:');
  console.log(JSON.stringify(event));
  const bucket_name = event['bucket_name'];
  const key = event['key'];

  const processed_invoices_bucket_name = process.env['ARCHIVE_BUCKET_NAME'];
  // copy object to archive bucket
  await s3_client.send(
    new CopyObjectCommand({
      Bucket: processed_invoices_bucket_name,
      Key: key,
      CopySource: `${bucket_name}/${key}`,
    })
  );

  // delete object from source bucket
  await s3_client.send(
    new DeleteObjectCommand({ Bucket: bucket_name, Key: key })
  );

  return event;
};
