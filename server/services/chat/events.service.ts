// events.ts (SDK v2 uses the built-in aws-sdk)
//import AWS from 'aws-sdk';
//const eb = new AWS.EventBridge();

export const publish = async (detailType: string, detail: any) => {
  /*
  await eb.putEvents({
    Entries: [{
      EventBusName: 'helloComputerBus',
      Source: 'hello-computer.chat',
      DetailType: detailType,
      Detail: JSON.stringify(detail)
    }]
  }).promise();
  */
};