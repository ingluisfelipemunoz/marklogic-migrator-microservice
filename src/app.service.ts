import { Injectable, Inject, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { Cron } from '@nestjs/schedule';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);
  private readonly controlTableName = 'ControlTable';
  private readonly dataTableName = 'migration-data-test';
  private readonly apiUrl = 'http://localhost:3000/documents/date-range';

  constructor(
    private readonly httpService: HttpService,
    @Inject('DYNAMODB_CLIENT')
    private readonly dynamoDbClient: DynamoDBDocumentClient,
  ) {}

  getHello() {
    return 'hello';
  }

  public async initializeControlTable() {
    try {
      const response = await this.dynamoDbClient.send(
        new GetCommand({
          TableName: this.controlTableName,
          Key: { id: 'lastProcessedTimestamp' },
        }),
      );

      //is present?
      if (!response.Item) {
        const initialTimestamp =
          new Date('2024-01-01T14:23:28.828Z').getTime() - 60000;
        await this.dynamoDbClient.send(
          new PutCommand({
            TableName: this.controlTableName,
            Item: {
              id: 'lastProcessedTimestamp',
              timestamp: initialTimestamp,
            },
          }),
        );
        this.logger.log(
          `Initialized control table with timestamp: ${initialTimestamp}`,
        );
      }
    } catch (error) {
      this.logger.error('Error initializing control table:', error);
    }
  }

  async testDynamoConnection() {
    try {
      const response = await this.dynamoDbClient.send(
        new GetCommand({
          TableName: this.dataTableName,
          Key: { id: 'testConnection' },
        }),
      );
      if (response.Item) {
        this.logger.log('DynamoDB connection test successful:', response.Item);
      } else {
        this.logger.log('DynamoDB connection test successful, no item found.');
      }
    } catch (error) {
      this.logger.error('DynamoDB connection test failed:', error);
    }
  }
  // main scheduler every 1 minute
  @Cron('*/1 * * * *')
  //@Cron('*/20 * * * * *')// test purpose: 20 seconds
  async handleCron() {
    const lastProcessedTimestamp = await this.getLastProcessedTimestamp();
    //validatingg if the current date is reached
    const currentTimestamp = Date.now();
    if (lastProcessedTimestamp >= currentTimestamp) {
      this.logger.log('No new data to process.');
      return;
    }
    const startTime = lastProcessedTimestamp + 1;
    const endTime = startTime + 60000; //todo: get this from the environment or configuraton

    this.logger.log(
      `Fetching data from ${new Date(startTime)} to ${new Date(endTime)}`,
    );

    const data = await this.fetchDataFromApi(startTime, endTime);
    this.logger.log(`current data lenght ${data.length}`);
    await this.sendDataToDynamoDB(data);

    // Update control table with th new timestamp//todo: improve this
    await this.updateLastProcessedTimestamp(endTime);
  }

  private async getLastProcessedTimestamp(): Promise<number> {
    try {
      const response = await this.dynamoDbClient.send(
        new GetCommand({
          TableName: this.controlTableName,
          Key: { id: 'lastProcessedTimestamp' },
        }),
      );

      return response.Item ? response.Item.timestamp : Date.now() - 60000; // Default to 1 minute ago if no record exists
    } catch (error) {
      this.logger.error('Error fetching last processed timestamp:', error);
      throw error;
    }
  }

  private async fetchDataFromApi(
    startTime: number,
    endTime: number,
  ): Promise<any[]> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(this.apiUrl, {
          params: {
            startDate: startTime.toString(),
            endDate: endTime.toString(),
          },
        }),
      );
      return response.data;
    } catch (error) {
      this.logger.error('Error fetching data from API:', error);
      return [];
    }
  }

  private async sendDataToDynamoDB(data: any[]): Promise<void> {
    for (const item of data) {
      try {
        await this.dynamoDbClient.send(
          new PutCommand({
            TableName: this.dataTableName,
            Item: { ...item, id: Date.now() }, //todo: extract id from item
          }),
        );
        this.logger.log(`Data item stored: ${JSON.stringify(item)}`);
      } catch (error) {
        this.logger.error(
          `Error sending data to DynamoDB for item: ${item.uri}`,
          error,
        );
      }
    }
  }

  private async updateLastProcessedTimestamp(timestamp: number): Promise<void> {
    try {
      await this.dynamoDbClient.send(
        new PutCommand({
          TableName: this.controlTableName,
          Item: {
            id: 'lastProcessedTimestamp',
            timestamp: timestamp,
          },
        }),
      );
      this.logger.log(
        `Updated last processed timestamp to: ${timestamp} -- ${new Date(
          timestamp,
        ).toISOString()}`,
      );
    } catch (error) {
      this.logger.error('Error updating last processed timestamp:', error);
    }
  }
}
