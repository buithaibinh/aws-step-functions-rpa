import {
  Stack,
  StackProps,
  RemovalPolicy,
  CfnOutput,
  Duration,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as kms from 'aws-cdk-lib/aws-kms';

import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as iam from 'aws-cdk-lib/aws-iam';
import { join } from 'path';

import {
  NodejsFunction,
  NodejsFunctionProps,
} from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { aws_dynamodb as dynamodb } from 'aws-cdk-lib';

import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Choice, Succeed } from 'aws-cdk-lib/aws-stepfunctions';

import { PythonFunction } from '@aws-cdk/aws-lambda-python-alpha';
export class AwsStepFunctionsRpaStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // kms key
    const kmsKey = new kms.Key(this, 'kmsKey', {
      description: 'kms key for aws-step-functions-rpa-stack',
      enableKeyRotation: false,
      removalPolicy: RemovalPolicy.DESTROY,
      pendingWindow: Duration.days(7),
      alias: 'alias/aws-step-functions-rpa-stack',
      // policy: new iam.PolicyDocument({
      //   statements: [new iam.PolicyStatement({
      //     actions: ['kms:*'],
      //   })],
      // }),
    });

    // ===== dynamodb table ======
    const dynamoCapacity = {
      readCapacity: 1,
      writeCapacity: 1,
    };
    const dbInvoicesTable = new dynamodb.Table(this, 'InvoicesTable', {
      partitionKey: { name: 'invoice_id', type: dynamodb.AttributeType.STRING },
      removalPolicy: RemovalPolicy.DESTROY,
      ...dynamoCapacity,
      billingMode: dynamodb.BillingMode.PROVISIONED,
    });
    dbInvoicesTable.addGlobalSecondaryIndex({
      indexName: 'payee_name_index',
      partitionKey: { name: 'payee_name', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
      ...dynamoCapacity,
    });
    dbInvoicesTable.addGlobalSecondaryIndex({
      indexName: 'due_date_index',
      partitionKey: { name: 'due_date', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
      ...dynamoCapacity,
    });
    // ===== dynamodb table ======

    // define s3 buckets
    const s3ScannedInvoicesBucket = new s3.Bucket(
      this,
      'ScannedInvoicesBucket',
      {
        versioned: true,
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
      }
    );

    // define s3 bucket for document analysis
    const s3DocumentAnalysisBucket = new s3.Bucket(
      this,
      'DocumentAnalysisBucket',
      {
        versioned: true,
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
      }
    );

    // s3 bucket for archive documents
    const s3ArchiveBucket = new s3.Bucket(this, 'ArchiveBucket', {
      versioned: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // sns
    const snsDocumentAnalysisCompletedTopic = new sns.Topic(
      this,
      'DocumentAnalysisCompletedTopic',
      {}
    );

    // sqs
    const sqsDocumentAnalysisCompletedQueue = new sqs.Queue(
      this,
      'DocumentAnalysisCompletedQueue',
      {
        visibilityTimeout: Duration.seconds(60),
        receiveMessageWaitTime: Duration.seconds(20),
        deliveryDelay: Duration.seconds(60),
        encryption: sqs.QueueEncryption.KMS_MANAGED,
        encryptionMasterKey: kmsKey,
      }
    );

    // subscribe to the sns topic
    snsDocumentAnalysisCompletedTopic.addSubscription(
      new subscriptions.SqsSubscription(sqsDocumentAnalysisCompletedQueue, {})
    );

    // roles
    const textractPublishToSnsRole = new iam.Role(
      this,
      'TextractPublishToSNSTopicRole',
      {
        assumedBy: new iam.ServicePrincipal('textract.amazonaws.com'),
        roleName: 'rpa-textract-publish-to-sns-role',
      }
    );
    snsDocumentAnalysisCompletedTopic.grantPublish(textractPublishToSnsRole);

    // lambda functions
    const nodeJsFunctionProps: NodejsFunctionProps = {
      bundling: {
        externalModules: [
          'aws-sdk', // Use the 'aws-sdk' available in the Lambda runtime
        ],
      },
      depsLockFilePath: join(
        __dirname,
        '..',
        'functions',
        'lambdas',
        'yarn.lock'
      ),
      runtime: Runtime.NODEJS_12_X,
    };

    // ===== Start functions =====
    const fnStartDocumentAnalysisFunction = new NodejsFunction(
      this,
      'StartDocumentAnalysisFunction',
      {
        entry: join(
          __dirname,
          '..',
          'functions',
          'lambdas',
          'start_document_analysis.ts'
        ),
        ...nodeJsFunctionProps,
        environment: {
          DOCUMENT_ANALYIS_COMPLETED_SNS_TOPIC_ARN:
            snsDocumentAnalysisCompletedTopic.topicArn,
          TEXTRACT_PUBLISH_TO_SNS_ROLE_ARN: textractPublishToSnsRole.roleArn,
        },
      }
    );

    // trigger
    s3ScannedInvoicesBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(fnStartDocumentAnalysisFunction),
      {
        suffix: '.pdf',
      }
    );

    // permissions
    s3ScannedInvoicesBucket.grantRead(fnStartDocumentAnalysisFunction);
    fnStartDocumentAnalysisFunction.role?.attachInlinePolicy(
      new iam.Policy(this, 'StartDocumentAnalysisFunctionPolicy', {
        statements: [
          new iam.PolicyStatement({
            actions: ['textract:StartDocumentAnalysis'],
            resources: ['*'],
          }),
        ],
      })
    );

    // ======== End function =========

    // ======== Save Document Analysis function =========
    const fnSaveDocumentAnalysisFunction = new NodejsFunction(
      this,
      'SaveDocumentAnalysisFunction',
      {
        entry: join(
          __dirname,
          '..',
          'functions',
          'lambdas',
          'save_document_analysis.ts'
        ),
        ...nodeJsFunctionProps,
        environment: {
          ANALYSES_BUCKET_NAME: s3DocumentAnalysisBucket.bucketName,
        },
      }
    );

    // permissions
    fnSaveDocumentAnalysisFunction.role?.attachInlinePolicy(
      new iam.Policy(this, 'SaveDocumentAnalysisFunctionPolicy', {
        statements: [
          new iam.PolicyStatement({
            actions: ['textract:GetDocumentAnalysis'],
            resources: ['*'],
          }),
        ],
      })
    );
    s3DocumentAnalysisBucket.grantReadWrite(fnSaveDocumentAnalysisFunction);
    // ======== End function =========

    // ======== Save Document Analysis function =========
    const fnProcessDocumentAnalysisFunction = new PythonFunction(
      this,
      'ProcessDocumentAnalysisFunction',
      {
        entry: join(__dirname, '..', 'functions', 'process_document_analysis'),
        runtime: Runtime.PYTHON_3_8, // required
        index: 'app.py', // optional, defaults to 'index.py'
        handler: 'lambda_handler', // optional, defaults to 'handler'
        environment: {
          INVOICES_TABLE_NAME: dbInvoicesTable.tableName,
        },
      }
    );
    // permissions
    dbInvoicesTable.grantReadWriteData(fnProcessDocumentAnalysisFunction);
    s3DocumentAnalysisBucket.grantRead(fnProcessDocumentAnalysisFunction);

    const fnArchiveDocumentFunction = new NodejsFunction(
      this,
      'ArchiveDocumentFunction',
      {
        entry: join(
          __dirname,
          '..',
          'functions',
          'lambdas',
          'archive_document.ts'
        ),
        ...nodeJsFunctionProps,
        environment: {
          ARCHIVE_BUCKET_NAME: s3ArchiveBucket.bucketName,
        },
      }
    );
    s3ScannedInvoicesBucket.grantReadWrite(fnArchiveDocumentFunction);
    s3ArchiveBucket.grantReadWrite(fnArchiveDocumentFunction);
    // ======== End function =========

    // ======== State machine =========
    const jobFailed = new sfn.Fail(this, 'Analyze Document Job Failed', {
      cause: 'Textract Job Failed',
      error: 'Analyze Document Job returned FAILED',
    });

    const processDocumentAnalysisTask = new tasks.LambdaInvoke(
      this,
      'ProcessDocumentAnalysis',
      {
        lambdaFunction: fnProcessDocumentAnalysisFunction,
        outputPath: '$.Payload',
      }
    );

    const documentSuccess = new sfn.Succeed(this, 'Document Success', {});

    const archiveDocumentTask = new tasks.LambdaInvoke(
      this,
      'ArchiveDocument',
      {
        lambdaFunction: fnArchiveDocumentFunction,
        inputPath: '$',
      }
    ).next(documentSuccess);

    const reviewDocumentAnalysisTask = new tasks.SnsPublish(
      this,
      'Review Document',
      {
        topic: new sns.Topic(this, 'PendingReviewTopic'),
        message: sfn.TaskInput.fromJsonPathAt('$'),
        resultPath: '$',
        inputPath: '$',
      }
    ).next(documentSuccess);

    const jobSucceeded = new tasks.LambdaInvoke(
      this,
      'Save Document Analysis',
      {
        lambdaFunction: fnSaveDocumentAnalysisFunction,
        inputPath: '$',
        outputPath: '$.Payload',
      }
    )
      .next(processDocumentAnalysisTask)
      .next(
        new Choice(this, 'Is Approved for Payment?', {})
          .when(
            sfn.Condition.stringEquals(
              '$.payment_info.status',
              'Approved for Payment'
            ),
            archiveDocumentTask
          )
          .when(
            sfn.Condition.stringEquals(
              '$.payment_info.status',
              'Pending Review'
            ),
            reviewDocumentAnalysisTask
          )
          .otherwise(reviewDocumentAnalysisTask)
      );

    const definition = new Choice(
      this,
      'Did Analyze Document Job Complete Successfully?'
    )
      .when(sfn.Condition.stringEquals('$.status', 'FAILED'), jobFailed)
      .when(sfn.Condition.stringEquals('$.status', 'SUCCEEDED'), jobSucceeded);

    // state machine
    const stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      definition,
      stateMachineName: 'ProcessScannedInvoiceWorkflow',
      timeout: Duration.seconds(300),
    });
    // ======== End function =========

    // ======== StartProcessScannedInvoiceWorkflowFunction function =========
    const fnStartProcessScannedInvoiceWorkflowFunction = new NodejsFunction(
      this,
      'StartProcessScannedInvoiceWorkflowFunction',
      {
        entry: join(
          __dirname,
          '..',
          'functions',
          'lambdas',
          'start_process_scanned_invoice_workflow.ts'
        ),
        ...nodeJsFunctionProps,
        environment: {
          STATE_MACHINE_ARN: stateMachine.stateMachineArn,
        },
      }
    );

    // trigger
    fnStartProcessScannedInvoiceWorkflowFunction.addEventSource(
      new SqsEventSource(sqsDocumentAnalysisCompletedQueue, {})
    );
    // permissions
    fnStartProcessScannedInvoiceWorkflowFunction.role?.attachInlinePolicy(
      new iam.Policy(this, 'StartProcessScannedInvoiceWorkflowFunctionPolicy', {
        statements: [
          new iam.PolicyStatement({
            actions: ['states:StartExecution'],
            resources: [stateMachine.stateMachineArn],
          }),
        ],
      })
    );

    // ======== End function =========

    // ======== Stack outputs
    // s3 bucket name
    new CfnOutput(this, 'S3BucketName', {
      value: s3ScannedInvoicesBucket.bucketName,
    });

    // sns topic name
    new CfnOutput(this, 'SNSTopicName', {
      value: snsDocumentAnalysisCompletedTopic.topicName,
    });
  }
}
